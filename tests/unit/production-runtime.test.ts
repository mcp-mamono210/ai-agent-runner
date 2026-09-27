import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createPhase48_1ProductionController,
  loadPhase48_1RuntimeConfig,
} from "../../src/controller/production-runtime.js";

void describe("Phase 48-1 production runtime config", () => {
  void it("loads Redmine candidate field bindings and existing Agent Brief persistence settings", () => {
    const config = loadPhase48_1RuntimeConfig({
      AGENT_RUNNER_ALLOWED_PROJECTS: "414",
      REDMINE_URL: "https://redmine.example.test",
      REDMINE_API_KEY: "read-key",
      REDMINE_WRITE_API_KEY: "write-key",
      AGENT_RUNNER_BRIEF_LIFECYCLE_FIELD_ID: "9",
      AGENT_RUNNER_EXECUTION_LIFECYCLE_FIELD_ID: "11",
      AGENT_BRIEF_REPOSITORY_ROOT: "/srv/redmine-briefs",
      AGENT_BRIEF_REPOSITORY: "mcp-mamono210/redmine",
      AGENT_BRIEF_REQUIREMENT_CUSTOM_FIELD_IDS: "21,7,21,9",
    });

    assert.equal(config.controller.pollIntervalMs, 30_000);
    assert.equal(config.redmine.lifecycleFieldId, 9);
    assert.equal(config.redmine.executionLifecycleFieldId, 11);
    assert.deepEqual(config.agentBrief.requirementCustomFieldIds, [7, 9, 21]);
    assert.equal(config.agentBrief.canonicalBranch, "main");
  });

  void it("fails closed without the environment-specific Brief lifecycle field binding", () => {
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

  void it("fails closed before production polling when the execution lifecycle field binding is absent", () => {
    const config = loadPhase48_1RuntimeConfig({
      AGENT_RUNNER_ALLOWED_PROJECTS: "414",
      REDMINE_URL: "https://redmine.example.test",
      REDMINE_API_KEY: "read-key",
      REDMINE_WRITE_API_KEY: "write-key",
      AGENT_RUNNER_BRIEF_LIFECYCLE_FIELD_ID: "9",
      AGENT_BRIEF_REPOSITORY_ROOT: "/srv/redmine-briefs",
      AGENT_BRIEF_REPOSITORY: "mcp-mamono210/redmine",
    });

    assert.throws(
      () => createPhase48_1ProductionController({
        config,
        startupReconciler: { reconcile: () => Promise.resolve() },
        eligibleCandidateHandler: { handle: () => Promise.resolve() },
      }),
      /AGENT_RUNNER_EXECUTION_LIFECYCLE_FIELD_ID is required/u,
    );
  });
});
