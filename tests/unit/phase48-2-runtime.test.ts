import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadPhase48_2RuntimeConfig } from "../../src/controller/phase48-2-runtime.js";

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

void describe("Phase 48-2 production runtime config", () => {
  void it("loads non-secret repository policy and source-selection configuration", () => {
    const config = loadPhase48_2RuntimeConfig(BASE_ENV);

    assert.deepEqual(config.repositoryAuthorization, {
      kind: "configured",
      entries: [
      {
        repository: "mcp-mamono210/redmine",
        remoteUrl: "https://github.com/mcp-mamono210/redmine.git",
        sourceRef: "refs/heads/main",
        usernameEnv: "AGENT_RUNNER_GIT_USERNAME",
        passwordEnv: "AGENT_RUNNER_GIT_READ_TOKEN",
      },
      ],
    });
  });

  void it("accepts an explicitly empty repository allowlist", () => {
    const config = loadPhase48_2RuntimeConfig({
      ...BASE_ENV,
      AGENT_RUNNER_REPOSITORY_CONFIG: "",
    });
    assert.deepEqual(config.repositoryAuthorization, {
      kind: "configured",
      entries: [],
    });
  });

  void it("keeps missing authorization configuration fail-closed for candidate rejection", () => {
    const { AGENT_RUNNER_REPOSITORY_CONFIG: _omitted, ...withoutRepositoryConfig } = BASE_ENV;
    const config = loadPhase48_2RuntimeConfig(withoutRepositoryConfig);
    assert.equal(config.repositoryAuthorization.kind, "invalid");
  });
});
