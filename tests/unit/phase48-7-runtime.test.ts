import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createPhase48_7DevelopmentRuntime,
  loadPhase48_7DevelopmentRuntimeConfig,
} from "../../src/controller/phase48-7-runtime.js";
import { KnownSecretRedactor } from "../../src/security/redaction.js";

function environment(): Record<string, string> {
  return {
    AGENT_RUNNER_ALLOWED_PROJECTS: "414",
    REDMINE_URL: "https://redmine.example.test",
    REDMINE_API_KEY: "read-key",
    REDMINE_WRITE_API_KEY: "write-key",
    AGENT_RUNNER_BRIEF_LIFECYCLE_FIELD_ID: "9",
    AGENT_RUNNER_EXECUTION_LIFECYCLE_FIELD_ID: "11",
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
      "agent-provider": { classification: "required", endpoints: ["https://provider.example.test"] },
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
  };
}

void describe("Phase 48-7 development runtime", () => {
  void it("adds only a development handoff / fixture-reset layer over the Phase 48-6 production runtime", () => {
    const env = environment();
    const config = loadPhase48_7DevelopmentRuntimeConfig(env);
    let resetCount = 0;
    const runtime = createPhase48_7DevelopmentRuntime({
      config,
      fixtureReset: {
        reset: () => {
          resetCount += 1;
          return Promise.resolve();
        },
      },
      agentAdapter: {
        runAgent: () => Promise.resolve({
          kind: "provisional_success",
          outcome: "no_changes",
          output: { text: "", capturedBytes: 0, truncated: false },
          diagnostic: { text: "", capturedBytes: 0, truncated: false },
        }),
      },
      failureFinalizer: { finalizeFailure: () => Promise.resolve() },
      interruptedFinalizer: { finalizeInterrupted: () => Promise.resolve() },
      orphanCleaner: {
        cleanup: () => Promise.resolve({ removedSandboxContainers: 0, removedWorkspaces: 0 }),
      },
      developmentChangeSetCollector: {
        collect: () => Promise.resolve({
          changedFiles: [],
          patch: { text: "", capturedBytes: 0, truncated: false },
        }),
      },
      redactor: new KnownSecretRedactor([]),
      environment: env,
    });

    assert.equal(config.patchCaptureBytes, 4 * 1024 * 1024);
    assert.equal(config.summaryCaptureBytes, 64 * 1024);
    assert.ok(runtime.controller !== undefined);
    assert.ok(runtime.startupReconciler !== undefined);
    assert.deepEqual(runtime.handoffStore.list(), []);
    assert.equal(resetCount, 0);
  });

  void it("allows explicit bounded development capture overrides without changing Phase 48 production limits", () => {
    const env = environment();
    env.AGENT_RUNNER_DEVELOPMENT_PATCH_CAPTURE_BYTES = "8192";
    env.AGENT_RUNNER_DEVELOPMENT_SUMMARY_CAPTURE_BYTES = "2048";

    const config = loadPhase48_7DevelopmentRuntimeConfig(env);

    assert.equal(config.patchCaptureBytes, 8192);
    assert.equal(config.summaryCaptureBytes, 2048);
    assert.equal(config.phase48_6.phase48_5.phase48_4.sandbox.resources.outputCaptureBytes, 1_048_576);
  });
});
