import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RedmineCandidateSource, RedmineIssueReader } from "../../src/redmine/adapters.js";
import { RedmineRestClient } from "../../src/redmine/rest-client.js";

function fetchImpl(input: RequestInfo | URL): Promise<Response> {
  const url = requestUrl(input);
  if (url.pathname.endsWith("/issues.json")) {
    assert.equal(url.searchParams.get("project_id"), "414");
    assert.equal(url.searchParams.get("cf_9"), "Ready for Agent");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          issues: [
            {
              id: 9001,
              project: { id: 414, name: "Redmine" },
            },
          ],
        }),
        { status: 200 },
      ),
    );
  }

  if (url.pathname.endsWith("/issues/9001.json")) {
    assert.equal(url.searchParams.get("include"), "journals,relations,children");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          issue: {
            id: 9001,
            project: { id: 414, name: "Redmine" },
            tracker: { id: 2, name: "Feature" },
            subject: "Candidate",
            description: "Candidate description",
            updated_on: "2026-09-17T00:00:00Z",
            custom_fields: [
              { id: 9, name: "Agent Brief Lifecycle", value: "Ready for Agent" },
            ],
            journals: [],
            relations: [],
            children: [],
          },
        }),
        { status: 200 },
      ),
    );
  }

  return Promise.resolve(new Response("not found", { status: 404 }));
}

function client(): RedmineRestClient {
  return new RedmineRestClient({
    baseUrl: "https://redmine.example.test",
    readApiKey: "read-key",
    writeApiKey: "write-key",
    fetchImpl,
  });
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

void describe("Redmine Phase 48-1 adapters", () => {
  void it("polls the allowed project with the environment-bound lifecycle custom-field ID", async () => {
    const source = new RedmineCandidateSource(client(), { lifecycleFieldId: 9 });
    const candidates = await source.listReadyForAgentCandidates({
      allowedProjectIds: [414],
      lifecycle: "Ready for Agent",
      limit: 1,
    });
    assert.deepEqual(candidates, [{ issueId: 9001, projectId: 414 }]);
  });

  void it("re-fetches the Issue and resolves lifecycle by exact canonical field name", async () => {
    const reader = new RedmineIssueReader(client());
    const issue = await reader.getIssue(9001);
    assert.equal(issue.issueId, 9001);
    assert.equal(issue.projectId, 414);
    assert.equal(issue.lifecycle, "Ready for Agent");
  });
});
