import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createPhase48_5ProductionRuntime,
  loadPhase48_5RuntimeConfig,
  parseSecretEnvironmentNames,
} from "../../src/controller/phase48-5-runtime.js";

function environment(): Record<string, string> {
  return {
    AGENT_RUNNER_ALLOWED_PROJECTS: "414",
    REDMINE_URL: "https://redmine.example.test",
    REDMINE_API_KEY: "read-key",
    REDMINE_WRITE_API_KEY: "write-key",
    AGENT_RUNNER_BRIEF_LIFECYCLE_FIELD_ID: "9",
    AGENT_BRIEF_REPOSITORY_ROOT: "/tmp/redmine",
    AGENT_BRIEF_REPOSITORY: "mcp-mamono210/redmine",
    AGENT_BRIEF_CANONICAL_BRANCH: "main",
    AGENT_RUNNER_REPOSITORY_CONFIG:
      "mcp-mamono210/redmine|https://github.example.test/redmine.git|refs/heads/main|GIT_USER|GIT_TOKEN",
    GIT_USER: "x-access-token",
    GIT_TOKEN: "read-only-token",
    AGENT_RUNNER_SANDBOX_RUNTIME: "docker",
    AGENT_RUNNER_AGENT_PROVIDER: "codex-cli",
    AGENT_RUNNER_SANDBOX_IMAGE:
      `registry.example.test/agent-codex@sha256:${"a".repeat(64)}`,
    AGENT_RUNNER_WORKSPACE_ROOT: "/var/lib/ai-agent-runner/workspaces",
    AGENT_RUNNER_SANDBOX_NETWORK_POLICY_JSON: JSON.stringify({
      "agent-provider": {
        classification: "required",
        endpoints: ["https://provider.example.test"],
      },
      "package-registry": { classification: "denied", endpoints: [] },
      "required-runtime-dependency": { classification: "denied", endpoints: [] },
      "source-repository": { classification: "denied", endpoints: [] },
      "other-external-endpoint": { classification: "denied", endpoints: [] },
    }),
    AGENT_RUNNER_SANDBOX_NETWORK_NAME: "agent-runner-egress",
    AGENT_RUNNER_SANDBOX_PROXY_CONTAINER: "agent-runner-egress-proxy",
    AGENT_RUNNER_SANDBOX_PROXY_URL: "http://agent-runner-egress-proxy:3128",
    AGENT_RUNNER_EXECUTION_TIMEOUT_MS: "600000",
    AGENT_RUNNER_OUTPUT_CAPTURE_BYTES: "1048576",
    AGENT_RUNNER_DIAGNOSTIC_CAPTURE_BYTES: "65536",
    AGENT_RUNNER_WORKSPACE_DISK_BYTES: "1073741824",
    AGENT_RUNNER_CONTAINER_LIFECYCLE_MS: "660000",
    AGENT_RUNNER_WORKSPACE_CHECK_INTERVAL_MS: "1000",
    AGENT_RUNNER_SANDBOX_TMPFS_BYTES: "67108864",
    AGENT_RUNNER_REDACTION_SECRET_ENV_NAMES: "EXTRA_SECRET",
    EXTRA_SECRET: "extra-secret",
  };
}

void describe("Phase 48-5 production composition", () => {
  void it("composes one-shot Agent routing after Phase 48-4 while leaving provisional success downstream", () => {
    const env = environment();
    const config = loadPhase48_5RuntimeConfig(env);
    const runtime = createPhase48_5ProductionRuntime({
      config,
      startupReconciler: { reconcile: () => Promise.resolve() },
      provisionalResultHandler: { handle: () => Promise.resolve() },
      agentAdapter: {
        runAgent: () => Promise.resolve({
          kind: "provisional_success",
          outcome: "no_changes",
          output: { text: "", capturedBytes: 0, truncated: false },
          diagnostic: { text: "", capturedBytes: 0, truncated: false },
        }),
      },
      failureFinalizer: { finalizeFailure: () => Promise.resolve() },
      environment: env,
    });

    assert.equal(runtime.sandboxConfig.agentProvider, "codex-cli");
    assert.deepEqual(config.redactionSecretEnvironmentNames, ["EXTRA_SECRET"]);
    assert.ok(runtime.controller !== undefined);
  });

  void it("fails closed when default Codex production adapter has no provider credential", () => {
    const env = environment();
    const config = loadPhase48_5RuntimeConfig(env);

    assert.throws(
      () => createPhase48_5ProductionRuntime({
        config,
        startupReconciler: { reconcile: () => Promise.resolve() },
        provisionalResultHandler: { handle: () => Promise.resolve() },
        environment: env,
      }),
      /AGENT_RUNNER_CODEX_API_KEY is required/u,
    );
  });

  void it("rejects ambiguous additional redaction secret configuration", () => {
    assert.deepEqual(parseSecretEnvironmentNames(undefined), []);
    assert.throws(
      () => parseSecretEnvironmentNames("EXTRA,EXTRA"),
      /contains duplicates/u,
    );
    assert.throws(
      () => parseSecretEnvironmentNames("bad-name"),
      /invalid environment name/u,
    );
  });
});
