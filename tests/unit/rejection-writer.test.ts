import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RedminePreExecutionRejectionWriter } from "../../src/redmine/rejection-writer.js";
import { RedmineRestClient } from "../../src/redmine/rest-client.js";

interface MutableField {
  id: number;
  name: string;
  value: string;
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
  void it("writes only rejection fields and verifies the durable read-back", async () => {
    const fields: MutableField[] = [
      { id: 11, name: "Agent Execution Lifecycle", value: "" },
      { id: 12, name: "Agent Rejection At", value: "" },
      { id: 13, name: "Agent Rejection Outcome", value: "" },
      { id: 14, name: "Agent Rejection Diagnostic", value: "" },
      { id: 15, name: "Agent Execution ID", value: "" },
    ];
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
    assert.equal(fields.find((field) => field.id === 11)?.value, "Needs Human");
    assert.equal(fields.find((field) => field.id === 12)?.value, "2026-09-17T01:02:03.000Z");
    assert.equal(fields.find((field) => field.id === 13)?.value, "eligibility_failed");
    assert.match(fields.find((field) => field.id === 14)?.value ?? "", /\[REDACTED\]/u);
    assert.equal(fields.find((field) => field.id === 15)?.value, "");
  });
});
