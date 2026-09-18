import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadSandboxRuntimeConfig } from "../../src/sandbox/config.js";

function policyJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    "agent-provider": {
      classification: "required",
      endpoints: ["https://provider.example.test"],
    },
    "package-registry": { classification: "denied", endpoints: [] },
    "required-runtime-dependency": { classification: "denied", endpoints: [] },
    "source-repository": { classification: "denied", endpoints: [] },
    "other-external-endpoint": { classification: "denied", endpoints: [] },
    ...overrides,
  });
}

function env(): Record<string, string> {
  return {
    AGENT_RUNNER_SANDBOX_RUNTIME: "docker",
    AGENT_RUNNER_AGENT_PROVIDER: "codex-cli",
    AGENT_RUNNER_SANDBOX_IMAGE:
      `registry.example.test/agent-codex@sha256:${"a".repeat(64)}`,
    AGENT_RUNNER_WORKSPACE_ROOT: "/var/lib/ai-agent-runner/workspaces",
    AGENT_RUNNER_SANDBOX_NETWORK_POLICY_JSON: policyJson(),
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

void describe("Phase 48-4 sandbox configuration", () => {
  void it("fixes Docker Engine and Codex CLI with finite resource limits", () => {
    const config = loadSandboxRuntimeConfig(env());

    assert.equal(config.runtime, "docker");
    assert.equal(config.agentProvider, "codex-cli");
    assert.match(config.network.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(config.network.categories.length, 5);
    assert.equal(
      config.network.categories.find((entry) => entry.category === "agent-provider")?.classification,
      "required",
    );
    assert.equal(
      config.network.categories.find((entry) => entry.category === "source-repository")?.classification,
      "denied",
    );
    assert.equal(config.resources.executionTimeoutMs, 600000);
    assert.equal(config.resources.containerLifecycleMs, 660000);
  });

  void it("fails closed for mutable images or unsupported runtime/provider", () => {
    const mutable = env();
    mutable.AGENT_RUNNER_SANDBOX_IMAGE = "registry.example.test/agent-codex:latest";
    assert.throws(() => loadSandboxRuntimeConfig(mutable), /pinned by sha256/u);

    const runtime = env();
    runtime.AGENT_RUNNER_SANDBOX_RUNTIME = "podman";
    assert.throws(() => loadSandboxRuntimeConfig(runtime), /must be docker/u);

    const provider = env();
    provider.AGENT_RUNNER_AGENT_PROVIDER = "other-provider";
    assert.throws(() => loadSandboxRuntimeConfig(provider), /must be codex-cli/u);
  });

  void it("does not permit unresolved/open Agent network policy", () => {
    const source = env();
    source.AGENT_RUNNER_SANDBOX_NETWORK_POLICY_JSON = policyJson({
      "source-repository": {
        classification: "allowed",
        endpoints: ["https://github.example.test"],
      },
    });
    assert.throws(
      () => loadSandboxRuntimeConfig(source),
      /source-repository network access is denied/u,
    );

    const wildcard = env();
    wildcard.AGENT_RUNNER_SANDBOX_NETWORK_POLICY_JSON = policyJson({
      "agent-provider": {
        classification: "required",
        endpoints: ["https://*.example.test"],
      },
    });
    assert.throws(() => loadSandboxRuntimeConfig(wildcard), /wildcard endpoint/u);
  });

  void it("requires lifecycle limit to exceed execution timeout", () => {
    const input = env();
    input.AGENT_RUNNER_CONTAINER_LIFECYCLE_MS = input.AGENT_RUNNER_EXECUTION_TIMEOUT_MS!;
    assert.throws(
      () => loadSandboxRuntimeConfig(input),
      /lifecycle limit must be greater/u,
    );
  });
});
