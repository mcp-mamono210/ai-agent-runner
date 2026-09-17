import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadPhase48_3RuntimeConfig } from "../../src/controller/phase48-3-runtime.js";

const BASE_ENV = {
  AGENT_RUNNER_ALLOWED_PROJECTS: "414",
  REDMINE_URL: "https://redmine.example.test",
  REDMINE_API_KEY: "read-key",
  REDMINE_WRITE_API_KEY: "write-key",
  AGENT_RUNNER_BRIEF_LIFECYCLE_FIELD_ID: "31",
  AGENT_BRIEF_REPOSITORY_ROOT: "/srv/redmine",
  AGENT_BRIEF_REPOSITORY: "mcp-mamono210/redmine",
  AGENT_RUNNER_REPOSITORY_CONFIG:
    "mcp-mamono210/redmine|https://github.com/mcp-mamono210/redmine.git|refs/heads/main|AGENT_RUNNER_GIT_USERNAME|AGENT_RUNNER_GIT_READ_TOKEN",
} as const;

void describe("Phase 48-3 production runtime config", () => {
  void it("reuses Phase 48-2 repository authorization without adding a second policy source", () => {
    const config = loadPhase48_3RuntimeConfig(BASE_ENV);
    assert.equal(config.phase48_2.repositoryAuthorization.kind, "configured");
    assert.deepEqual(config.phase48_2.phase48_1.controller.allowedProjectIds, [414]);
  });
});
