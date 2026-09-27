import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RedmineRestClient } from "../../src/redmine/rest-client.js";
import { RedmineAgentRunningExecutionSource } from "../../src/recovery/redmine-source.js";

void describe("Phase 48-6 Agent Running source", () => {
  void it("queries exact allowed projects without subprojects and revalidates Agent Running from the response", async () => {
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
          issues: [{
            id: projectId === 414 ? 5415 : 6415,
            project: { id: projectId },
            custom_fields: [{ id: 11, value: "Agent Running" }],
          }],
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
      assert.equal(url.searchParams.get("subproject_id"), "!*");
      assert.equal(url.searchParams.get("cf_11"), "Agent Running");
      assert.equal(url.searchParams.get("status_id"), "*");
      assert.equal(url.searchParams.get("limit"), "100");
    }
  });

  void it("fails closed when the list response contains another project", async () => {
    const source = new RedmineAgentRunningExecutionSource({
      client: new RedmineRestClient({
        baseUrl: "https://redmine.example.test",
        readApiKey: "read-key",
        writeApiKey: "write-key",
        fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
          issues: [{
            id: 5415,
            project: { id: 999 },
            custom_fields: [{ id: 11, value: "Agent Running" }],
          }],
        }), { status: 200 })),
      }),
      allowedProjectIds: [414],
      executionLifecycleFieldId: 11,
    });

    await assert.rejects(
      source.listAgentRunningExecutions(),
      /did not satisfy the requested project and lifecycle predicate/u,
    );
  });

  void it("fails closed when Redmine ignores the Agent Running custom-field predicate", async () => {
    const source = new RedmineAgentRunningExecutionSource({
      client: new RedmineRestClient({
        baseUrl: "https://redmine.example.test",
        readApiKey: "read-key",
        writeApiKey: "write-key",
        fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
          issues: [{
            id: 5415,
            project: { id: 414 },
            custom_fields: [{ id: 11, value: "Needs Human" }],
          }],
        }), { status: 200 })),
      }),
      allowedProjectIds: [414],
      executionLifecycleFieldId: 11,
    });

    await assert.rejects(
      source.listAgentRunningExecutions(),
      /did not satisfy the requested project and lifecycle predicate/u,
    );
  });
});
