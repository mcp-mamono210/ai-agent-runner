import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PreparedExecution } from "../../src/execution/types.js";
import { RedmineAgentRunningWriter } from "../../src/redmine/execution-writer.js";
import { RedmineRestClient } from "../../src/redmine/rest-client.js";

interface MutableField {
  id: number;
  name: string;
  value: string;
}

const FIELD_NAMES = [
  "Agent Execution Lifecycle",
  "Agent Rejection At",
  "Agent Rejection Outcome",
  "Agent Rejection Diagnostic",
  "Agent Execution ID",
  "Agent Exec Brief Revision",
  "Agent Exec Persisted Revision",
  "Agent Exec Req Fingerprint",
  "Agent Execution Repository",
  "Agent Exec Source Revision",
  "Agent Execution Started At",
  "Agent Execution Finished At",
  "Agent Execution Outcome",
  "Agent Artifact Reference",
] as const;

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === "string") {
    return new URL(input);
  }
  return new URL(input.url);
}

function createFields(): MutableField[] {
  return FIELD_NAMES.map((name, index) => ({
    id: 11 + index,
    name,
    value: name.startsWith("Agent Rejection") ? "stale-value" : "",
  }));
}

function issuePayload(fields: readonly MutableField[]): unknown {
  return {
    issue: {
      id: 5412,
      project: { id: 414, name: "Redmine" },
      tracker: { id: 2, name: "Feature" },
      subject: "Execution preparation",
      description: "Execution preparation",
      updated_on: "2026-09-17T00:00:00Z",
      custom_fields: fields,
      journals: [],
      relations: [],
      children: [],
    },
  };
}

function execution(): PreparedExecution {
  const pending = Object.freeze({ kind: "pending" }) satisfies {
    readonly kind: "pending";
  };
  const approvedBriefReference = Object.freeze({
    repository: "mcp-mamono210/redmine",
    issueId: 5412,
    briefRevision: 3,
    persistedRevision: "persisted-revision",
  });
  const input = Object.freeze({
    executionId: "123e4567-e89b-42d3-a456-426614174000",
    issueId: 5412,
    repository: "mcp-mamono210/redmine",
    sourceRevision: "b".repeat(40),
    briefRevision: 3,
    persistedRevision: "persisted-revision",
    requirementsFingerprint: `sha256:${"a".repeat(64)}`,
    approvedBriefReference,
  });
  return Object.freeze({
    issue: { issueId: 5412, projectId: 414, lifecycle: "Ready for Agent", raw: {} },
    handoff: {
      issueId: 5412,
      repository: input.repository,
      approvedRequirementsFingerprint: input.requirementsFingerprint,
      opaque: {},
    },
    input,
    record: Object.freeze({
      executionId: input.executionId,
      issueId: input.issueId,
      briefRevision: input.briefRevision,
      persistedRevision: input.persistedRevision,
      requirementsFingerprint: input.requirementsFingerprint,
      repository: input.repository,
      sourceRevision: input.sourceRevision,
      startedAt: "2026-09-17T01:02:03.000Z",
      finishedAt: pending,
      outcome: pending,
      artifactReference: pending,
    }),
  });
}

void describe("Redmine Agent Running durable writer", () => {
  void it("writes one complete start projection and confirms exact read-back", async () => {
    const fields = createFields();
    let putCount = 0;
    const fakeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.pathname.endsWith("/issues/5412.json")) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if ((init?.method ?? "GET") === "PUT") {
        putCount += 1;
        const body = typeof init?.body === "string" ? init.body : "";
        const parsed = JSON.parse(body) as {
          issue: { custom_fields: Array<{ id: number; value: string }> };
        };
        assert.equal(parsed.issue.custom_fields.length, 14);
        for (const update of parsed.issue.custom_fields) {
          const field = fields.find((candidate) => candidate.id === update.id);
          if (field === undefined) {
            throw new Error("unexpected execution field write");
          }
          field.value = update.value;
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(issuePayload(fields)), { status: 200 }),
      );
    };
    const client = new RedmineRestClient({
      baseUrl: "https://redmine.example.test",
      readApiKey: "read-key",
      writeApiKey: "write-key",
      fetchImpl: fakeFetch,
    });
    const writer = new RedmineAgentRunningWriter({
      client,
      allowedProjectIds: [414],
    });

    await writer.persistAndConfirm(execution());

    assert.equal(putCount, 1);
    const values = new Map(fields.map((field) => [field.name, field.value]));
    assert.equal(values.get("Agent Execution Lifecycle"), "Agent Running");
    assert.equal(values.get("Agent Rejection At"), "");
    assert.equal(values.get("Agent Rejection Outcome"), "");
    assert.equal(values.get("Agent Rejection Diagnostic"), "");
    assert.equal(
      values.get("Agent Execution ID"),
      "123e4567-e89b-42d3-a456-426614174000",
    );
    assert.equal(values.get("Agent Exec Brief Revision"), "3");
    assert.equal(values.get("Agent Exec Persisted Revision"), "persisted-revision");
    assert.equal(values.get("Agent Exec Req Fingerprint"), `sha256:${"a".repeat(64)}`);
    assert.equal(values.get("Agent Execution Repository"), "mcp-mamono210/redmine");
    assert.equal(values.get("Agent Exec Source Revision"), "b".repeat(40));
    assert.equal(values.get("Agent Execution Started At"), "2026-09-17T01:02:03.000Z");
    assert.equal(values.get("Agent Execution Finished At"), "");
    assert.equal(values.get("Agent Execution Outcome"), "");
    assert.equal(values.get("Agent Artifact Reference"), "");
  });

  void it("does not treat HTTP success as durable success when read-back mismatches", async () => {
    const fields = createFields();
    let getCount = 0;
    const fakeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.pathname.endsWith("/issues/5412.json")) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if ((init?.method ?? "GET") === "PUT") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      getCount += 1;
      if (getCount >= 2) {
        const lifecycle = fields.find((field) => field.name === "Agent Execution Lifecycle");
        if (lifecycle !== undefined) {
          lifecycle.value = "";
        }
      }
      return Promise.resolve(
        new Response(JSON.stringify(issuePayload(fields)), { status: 200 }),
      );
    };
    const writer = new RedmineAgentRunningWriter({
      client: new RedmineRestClient({
        baseUrl: "https://redmine.example.test",
        readApiKey: "read-key",
        writeApiKey: "write-key",
        fetchImpl: fakeFetch,
      }),
      allowedProjectIds: [414],
    });

    await assert.rejects(
      writer.persistAndConfirm(execution()),
      /read-back mismatch: Agent Execution Lifecycle/u,
    );
  });

  void it("fails closed before mutation when execution field binding is incomplete", async () => {
    const fields = createFields().filter(
      (field) => field.name !== "Agent Exec Source Revision",
    );
    let putCount = 0;
    const fakeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.pathname.endsWith("/issues/5412.json")) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if ((init?.method ?? "GET") === "PUT") {
        putCount += 1;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(issuePayload(fields)), { status: 200 }),
      );
    };
    const writer = new RedmineAgentRunningWriter({
      client: new RedmineRestClient({
        baseUrl: "https://redmine.example.test",
        readApiKey: "read-key",
        writeApiKey: "write-key",
        fetchImpl: fakeFetch,
      }),
      allowedProjectIds: [414],
    });

    await assert.rejects(
      writer.persistAndConfirm(execution()),
      /Required Redmine custom field is missing/u,
    );
    assert.equal(putCount, 0);
  });
});
