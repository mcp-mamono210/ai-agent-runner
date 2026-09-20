import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RedmineInterruptedExecutionFinalizer } from "../../src/redmine/interrupted-finalizer.js";
import { RedmineRestClient } from "../../src/redmine/rest-client.js";

interface MutableField {
  id: number;
  name: string;
  value: string;
}

const FIELD_NAMES = [
  "Agent Execution Lifecycle",
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

function fields(): MutableField[] {
  const values = new Map<string, string>([
    ["Agent Execution Lifecycle", "Agent Running"],
    ["Agent Execution ID", "123e4567-e89b-42d3-a456-426614174000"],
    ["Agent Exec Brief Revision", "5"],
    ["Agent Exec Persisted Revision", "persisted-revision"],
    ["Agent Exec Req Fingerprint", `sha256:${"b".repeat(64)}`],
    ["Agent Execution Repository", "mcp-mamono210/redmine"],
    ["Agent Exec Source Revision", "a".repeat(40)],
    ["Agent Execution Started At", "2026-09-19T00:00:00.000Z"],
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

function issuePayload(current: readonly MutableField[]): unknown {
  return {
    issue: {
      id: 5415,
      project: { id: 414, name: "Redmine" },
      tracker: { id: 2, name: "Feature" },
      subject: "Phase 48-6",
      description: "Phase 48-6",
      updated_on: "2026-09-19T00:00:00Z",
      custom_fields: current,
      journals: [],
      relations: [],
      children: [],
    },
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

void describe("Phase 48-6 interrupted finalization", () => {
  void it("writes Needs Human + interrupted + finished_at while preserving durable start identity", async () => {
    const current = fields();
    const identityBefore = new Map(current.map((field) => [field.name, field.value]));
    let putCount = 0;
    const fakeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.pathname.endsWith("/issues/5415.json")) {
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
          const target = current.find((field) => field.id === update.id);
          if (target === undefined) throw new Error("unexpected field update");
          target.value = update.value;
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(JSON.stringify(issuePayload(current)), { status: 200 }));
    };
    const finalizer = new RedmineInterruptedExecutionFinalizer({
      client: new RedmineRestClient({
        baseUrl: "https://redmine.example.test",
        readApiKey: "read-key",
        writeApiKey: "write-key",
        fetchImpl: fakeFetch,
      }),
      allowedProjectIds: [414],
      clock: () => new Date("2026-09-19T02:03:04Z"),
    });

    await finalizer.finalizeInterrupted(5415);

    assert.equal(putCount, 1);
    const values = new Map(current.map((field) => [field.name, field.value]));
    assert.equal(values.get("Agent Execution Lifecycle"), "Needs Human");
    assert.equal(values.get("Agent Execution Finished At"), "2026-09-19T02:03:04.000Z");
    assert.equal(values.get("Agent Execution Outcome"), "interrupted");
    assert.equal(values.get("Agent Artifact Reference"), "");
    for (const name of [
      "Agent Execution ID",
      "Agent Exec Brief Revision",
      "Agent Exec Persisted Revision",
      "Agent Exec Req Fingerprint",
      "Agent Execution Repository",
      "Agent Exec Source Revision",
      "Agent Execution Started At",
    ]) {
      assert.equal(values.get(name), identityBefore.get(name));
    }
  });

  void it("does not retry the Redmine write when interrupted finalization fails", async () => {
    const current = fields();
    let putCount = 0;
    const finalizer = new RedmineInterruptedExecutionFinalizer({
      client: new RedmineRestClient({
        baseUrl: "https://redmine.example.test",
        readApiKey: "read-key",
        writeApiKey: "write-key",
        fetchImpl: (_input, init) => {
          if ((init?.method ?? "GET") === "PUT") {
            putCount += 1;
            return Promise.resolve(new Response("failed", { status: 500 }));
          }
          return Promise.resolve(new Response(JSON.stringify(issuePayload(current)), { status: 200 }));
        },
      }),
      allowedProjectIds: [414],
    });

    await assert.rejects(finalizer.finalizeInterrupted(5415), /HTTP 500/u);
    assert.equal(putCount, 1);
    assert.equal(
      current.find((field) => field.name === "Agent Execution Lifecycle")?.value,
      "Agent Running",
    );
  });

  void it("rejects incomplete durable execution identity before writing", async () => {
    const current = fields();
    const source = current.find((field) => field.name === "Agent Exec Source Revision");
    if (source !== undefined) source.value = "main";
    let putCount = 0;
    const finalizer = new RedmineInterruptedExecutionFinalizer({
      client: new RedmineRestClient({
        baseUrl: "https://redmine.example.test",
        readApiKey: "read-key",
        writeApiKey: "write-key",
        fetchImpl: (_input, init) => {
          if ((init?.method ?? "GET") === "PUT") {
            putCount += 1;
            return Promise.resolve(new Response(null, { status: 204 }));
          }
          return Promise.resolve(new Response(JSON.stringify(issuePayload(current)), { status: 200 }));
        },
      }),
      allowedProjectIds: [414],
    });

    await assert.rejects(finalizer.finalizeInterrupted(5415), /source revision is invalid/u);
    assert.equal(putCount, 0);
  });
});
