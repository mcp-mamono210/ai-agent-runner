import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PreparedExecution } from "../../src/execution/types.js";
import { RedmineStartedExecutionFailureFinalizer } from "../../src/redmine/execution-finalizer.js";
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

function execution(): PreparedExecution {
  const pending = Object.freeze({ kind: "pending" }) satisfies { readonly kind: "pending" };
  const reference = Object.freeze({
    repository: "mcp-mamono210/redmine",
    issueId: 5414,
    briefRevision: 5,
    persistedRevision: "persisted",
  });
  const input = Object.freeze({
    executionId: "123e4567-e89b-42d3-a456-426614174000",
    issueId: 5414,
    repository: reference.repository,
    sourceRevision: "a".repeat(40),
    briefRevision: 5,
    persistedRevision: reference.persistedRevision,
    requirementsFingerprint: `sha256:${"b".repeat(64)}`,
    approvedBriefReference: reference,
  });
  return Object.freeze({
    issue: { issueId: 5414, projectId: 414, lifecycle: "Ready for Agent", raw: {} },
    handoff: {
      issueId: 5414,
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
      startedAt: "2026-09-19T00:00:00.000Z",
      finishedAt: pending,
      outcome: pending,
      artifactReference: pending,
    }),
  });
}

function fieldsFor(executionValue = execution()): MutableField[] {
  const values = new Map<string, string>([
    ["Agent Execution Lifecycle", "Agent Running"],
    ["Agent Rejection At", ""],
    ["Agent Rejection Outcome", ""],
    ["Agent Rejection Diagnostic", ""],
    ["Agent Execution ID", executionValue.input.executionId],
    ["Agent Exec Brief Revision", String(executionValue.input.briefRevision)],
    ["Agent Exec Persisted Revision", executionValue.input.persistedRevision],
    ["Agent Exec Req Fingerprint", executionValue.input.requirementsFingerprint],
    ["Agent Execution Repository", executionValue.input.repository],
    ["Agent Exec Source Revision", executionValue.input.sourceRevision],
    ["Agent Execution Started At", executionValue.record.startedAt],
    ["Agent Execution Finished At", ""],
    ["Agent Execution Outcome", ""],
    ["Agent Artifact Reference", ""],
  ]);
  return FIELD_NAMES.map((name, index) => ({
    id: 11 + index,
    name,
    value: values.get(name) ?? "",
  }));
}

function issuePayload(fields: readonly MutableField[]): unknown {
  return {
    issue: {
      id: 5414,
      project: { id: 414, name: "Redmine" },
      tracker: { id: 2, name: "Feature" },
      subject: "Phase 48-5",
      description: "Phase 48-5",
      updated_on: "2026-09-19T00:00:00Z",
      custom_fields: fields,
      journals: [],
      relations: [],
      children: [],
    },
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === "string") {
    return new URL(input);
  }
  return new URL(input.url);
}

void describe("Phase 48-5 started-execution failure finalization", () => {
  void it("writes Needs Human + finished_at + exact outcome while preserving execution identity", async () => {
    const executionValue = execution();
    const fields = fieldsFor(executionValue);
    let putCount = 0;
    const fakeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.pathname.endsWith("/issues/5414.json")) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if ((init?.method ?? "GET") === "PUT") {
        putCount += 1;
        const body = typeof init?.body === "string" ? init.body : "";
        const parsed = JSON.parse(body) as {
          issue: { custom_fields: Array<{ id: number; value: string }> };
        };
        assert.equal(parsed.issue.custom_fields.length, 4);
        for (const update of parsed.issue.custom_fields) {
          const target = fields.find((field) => field.id === update.id);
          if (target === undefined) {
            throw new Error("unexpected field update");
          }
          target.value = update.value;
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(JSON.stringify(issuePayload(fields)), { status: 200 }));
    };
    const finalizer = new RedmineStartedExecutionFailureFinalizer({
      client: new RedmineRestClient({
        baseUrl: "https://redmine.example.test",
        readApiKey: "read-key",
        writeApiKey: "write-key",
        fetchImpl: fakeFetch,
      }),
      allowedProjectIds: [414],
      clock: () => new Date("2026-09-19T01:02:03Z"),
    });

    await finalizer.finalizeFailure({ execution: executionValue, outcome: "timeout" });

    assert.equal(putCount, 1);
    const values = new Map(fields.map((field) => [field.name, field.value]));
    assert.equal(values.get("Agent Execution Lifecycle"), "Needs Human");
    assert.equal(values.get("Agent Execution Finished At"), "2026-09-19T01:02:03.000Z");
    assert.equal(values.get("Agent Execution Outcome"), "timeout");
    assert.equal(values.get("Agent Artifact Reference"), "");
    assert.equal(values.get("Agent Execution ID"), executionValue.input.executionId);
    assert.equal(values.get("Agent Exec Source Revision"), executionValue.input.sourceRevision);
  });

  void it("does not retry or claim success when the finalization write fails", async () => {
    const fields = fieldsFor();
    let putCount = 0;
    const fakeFetch = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? "GET") === "PUT") {
        putCount += 1;
        return Promise.resolve(new Response("failed", { status: 500 }));
      }
      return Promise.resolve(new Response(JSON.stringify(issuePayload(fields)), { status: 200 }));
    };
    const finalizer = new RedmineStartedExecutionFailureFinalizer({
      client: new RedmineRestClient({
        baseUrl: "https://redmine.example.test",
        readApiKey: "read-key",
        writeApiKey: "write-key",
        fetchImpl: fakeFetch,
      }),
      allowedProjectIds: [414],
    });

    await assert.rejects(
      finalizer.finalizeFailure({ execution: execution(), outcome: "agent_failed" }),
      /HTTP 500/u,
    );
    assert.equal(putCount, 1);
    assert.equal(
      fields.find((field) => field.name === "Agent Execution Lifecycle")?.value,
      "Agent Running",
    );
  });

  void it("rejects stale identity instead of finalizing a different started attempt", async () => {
    const fields = fieldsFor();
    const executionId = fields.find((field) => field.name === "Agent Execution ID");
    if (executionId !== undefined) {
      executionId.value = "00000000-0000-4000-8000-000000000000";
    }
    let putCount = 0;
    const finalizer = new RedmineStartedExecutionFailureFinalizer({
      client: new RedmineRestClient({
        baseUrl: "https://redmine.example.test",
        readApiKey: "read-key",
        writeApiKey: "write-key",
        fetchImpl: (_input, init) => {
          if ((init?.method ?? "GET") === "PUT") {
            putCount += 1;
            return Promise.resolve(new Response(null, { status: 204 }));
          }
          return Promise.resolve(new Response(JSON.stringify(issuePayload(fields)), { status: 200 }));
        },
      }),
      allowedProjectIds: [414],
    });

    await assert.rejects(
      finalizer.finalizeFailure({ execution: execution(), outcome: "agent_start_failed" }),
      /Agent Execution ID/u,
    );
    assert.equal(putCount, 0);
  });
});
