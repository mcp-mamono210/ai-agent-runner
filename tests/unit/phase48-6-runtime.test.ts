import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createPhase48_6ProductionRuntime,
  loadPhase48_6RuntimeConfig,
} from "../../src/controller/phase48-6-runtime.js";
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

void describe("Phase 48-6 production composition", () => {
  void it("binds concrete startup reconciliation before polling with an explicit execution lifecycle field", async () => {
    const env = environment();
    const config = loadPhase48_6RuntimeConfig(env);
    const order: string[] = [];
    const fakeFetch = (input: RequestInfo | URL): Promise<Response> => {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/issues.json")) {
        order.push("list-agent-running");
        assert.equal(url.searchParams.get("cf_11"), "Agent Running");
        return Promise.resolve(new Response(JSON.stringify({ issues: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    };
    const runtime = createPhase48_6ProductionRuntime({
      config,
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
      orphanCleaner: {
        cleanup: () => {
          order.push("cleanup");
          return Promise.resolve({ removedSandboxContainers: 0, removedWorkspaces: 0 });
        },
      },
      interruptedFinalizer: { finalizeInterrupted: () => Promise.resolve() },
      redactor: new KnownSecretRedactor([]),
      environment: env,
      fetchImpl: fakeFetch,
    });

    await runtime.startupReconciler.reconcile();

    assert.equal(config.executionLifecycleFieldId, 11);
    assert.deepEqual(order, ["cleanup", "list-agent-running"]);
    assert.ok(runtime.controller !== undefined);
  });

  void it("fails closed when the execution lifecycle field ID is missing", () => {
    const env = environment();
    delete env.AGENT_RUNNER_EXECUTION_LIFECYCLE_FIELD_ID;
    assert.throws(
      () => loadPhase48_6RuntimeConfig(env),
      /AGENT_RUNNER_EXECUTION_LIFECYCLE_FIELD_ID/u,
    );
  });
});
