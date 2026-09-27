import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RedminePreExecutionRejectionWriter } from "../../src/redmine/rejection-writer.js";
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
  "Agent Rejection At",
  "Agent Rejection Outcome",
  "Agent Rejection Diagnostic",
] as const;

function createFields(): MutableField[] {
  return FIELD_NAMES.map((name, index) => ({ id: 11 + index, name, value: "" }));
}

function issuePayload(fields: readonly MutableField[]): unknown {
  return {
    issue: {
      id: 9001,
      project: { id: 414, name: "Redmine" },
      tracker: { id: 2, name: "Feature" },
      subject: "Rejected candidate",
      description: "Rejected candidate",
      updated_on: "2026-09-17T00:00:00Z",
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

void describe("Redmine pre-execution rejection writer", () => {
  void it("writes only rejection fields from pristine durable state and verifies read-back", async () => {
    const fields = createFields();
    let putCount = 0;

    const fakeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.pathname.endsWith("/issues/9001.json")) {
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
          const field = fields.find((candidate) => candidate.id === update.id);
          if (field === undefined) {
            throw new Error("unexpected custom field write");
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
      readApiKey: "read-secret",
      writeApiKey: "write-secret",
      fetchImpl: fakeFetch,
    });
    const writer = new RedminePreExecutionRejectionWriter({
      client,
      allowedProjectIds: [414],
      secretValues: ["read-secret", "write-secret"],
      clock: () => new Date("2026-09-17T01:02:03Z"),
    });

    await writer.reject({
      issueId: 9001,
      outcome: "eligibility_failed",
      diagnostic: "token=write-secret validation failed",
    });

    assert.equal(putCount, 1);
    assert.equal(fields.find((field) => field.name === "Agent Execution Lifecycle")?.value, "Needs Human");
    assert.equal(fields.find((field) => field.name === "Agent Rejection At")?.value, "2026-09-17T01:02:03.000Z");
    assert.equal(fields.find((field) => field.name === "Agent Rejection Outcome")?.value, "eligibility_failed");
    assert.match(fields.find((field) => field.name === "Agent Rejection Diagnostic")?.value ?? "", /\[REDACTED\]/u);
    assert.equal(fields.find((field) => field.name === "Agent Execution ID")?.value, "");
  });

  void it("refuses every existing durable execution or rejection value without overwriting it", async () => {
    for (const nonPristineName of FIELD_NAMES) {
      const fields = createFields();
      const nonPristine = fields.find((field) => field.name === nonPristineName);
      if (nonPristine === undefined) {
        throw new Error("missing non-pristine fixture field");
      }
      nonPristine.value = "existing-durable-state";
      let putCount = 0;
      const writer = new RedminePreExecutionRejectionWriter({
        client: new RedmineRestClient({
          baseUrl: "https://redmine.example.test",
          readApiKey: "read-key",
          writeApiKey: "write-key",
          fetchImpl: (input, init) => {
            const url = requestUrl(input);
            if (!url.pathname.endsWith("/issues/9001.json")) {
              return Promise.resolve(new Response("not found", { status: 404 }));
            }
            if ((init?.method ?? "GET") === "PUT") {
              putCount += 1;
              return Promise.resolve(new Response(null, { status: 204 }));
            }
            return Promise.resolve(
              new Response(JSON.stringify(issuePayload(fields)), { status: 200 }),
            );
          },
        }),
        allowedProjectIds: [414],
      });

      await assert.rejects(
        writer.reject({
          issueId: 9001,
          outcome: "eligibility_failed",
          diagnostic: "fixture rejection",
        }),
        /durable execution\/rejection state is not pristine/u,
      );
      assert.equal(putCount, 0, nonPristineName);
      assert.equal(nonPristine.value, "existing-durable-state");
    }
  });
});
