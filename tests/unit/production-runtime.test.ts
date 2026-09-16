import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadPhase48_1RuntimeConfig } from "../../src/controller/production-runtime.js";

void describe("Phase 48-1 production runtime config", () => {
  void it("loads Redmine and existing Agent Brief persistence settings", () => {
    const config = loadPhase48_1RuntimeConfig({
      AGENT_RUNNER_ALLOWED_PROJECTS: "414",
      REDMINE_URL: "https://redmine.example.test",
      REDMINE_API_KEY: "read-key",
      REDMINE_WRITE_API_KEY: "write-key",
      AGENT_RUNNER_BRIEF_LIFECYCLE_FIELD_ID: "9",
      AGENT_BRIEF_REPOSITORY_ROOT: "/srv/redmine-briefs",
      AGENT_BRIEF_REPOSITORY: "mcp-mamono210/redmine",
      AGENT_BRIEF_REQUIREMENT_CUSTOM_FIELD_IDS: "21,7,21,9",
    });

    assert.equal(config.controller.pollIntervalMs, 30_000);
    assert.equal(config.redmine.lifecycleFieldId, 9);
    assert.deepEqual(config.agentBrief.requirementCustomFieldIds, [7, 9, 21]);
    assert.equal(config.agentBrief.canonicalBranch, "main");
  });

  void it("fails closed without the environment-specific lifecycle field binding", () => {
    assert.throws(
      () =>
        loadPhase48_1RuntimeConfig({
          AGENT_RUNNER_ALLOWED_PROJECTS: "414",
          REDMINE_URL: "https://redmine.example.test",
          REDMINE_API_KEY: "read-key",
          REDMINE_WRITE_API_KEY: "write-key",
          AGENT_BRIEF_REPOSITORY_ROOT: "/srv/redmine-briefs",
          AGENT_BRIEF_REPOSITORY: "mcp-mamono210/redmine",
        }),
      /AGENT_RUNNER_BRIEF_LIFECYCLE_FIELD_ID is required/u,
    );
  });
});
