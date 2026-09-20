import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RedmineRestClient } from "../../src/redmine/rest-client.js";
import { RedmineAgentRunningExecutionSource } from "../../src/recovery/redmine-source.js";

void describe("Phase 48-6 Agent Running source", () => {
  void it("queries only allowed projects with the configured execution lifecycle field", async () => {
    const urls: URL[] = [];
    const client = new RedmineRestClient({
      baseUrl: "https://redmine.example.test",
      readApiKey: "read-key",
      writeApiKey: "write-key",
      fetchImpl: (input) => {
        const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
        urls.push(url);
        const projectId = Number(url.searchParams.get("project_id"));
        return Promise.resolve(new Response(JSON.stringify({
          issues: [{ id: projectId === 414 ? 5415 : 6415, project: { id: projectId } }],
        }), { status: 200 }));
      },
    });
    const source = new RedmineAgentRunningExecutionSource({
      client,
      allowedProjectIds: [414, 415],
      executionLifecycleFieldId: 11,
    });

    const result = await source.listAgentRunningExecutions();

    assert.deepEqual(result, [
      { issueId: 5415, projectId: 414 },
      { issueId: 6415, projectId: 415 },
    ]);
    assert.equal(urls.length, 2);
    for (const url of urls) {
      assert.equal(url.searchParams.get("cf_11"), "Agent Running");
      assert.equal(url.searchParams.get("status_id"), "*");
      assert.equal(url.searchParams.get("limit"), "100");
    }
  });
});
