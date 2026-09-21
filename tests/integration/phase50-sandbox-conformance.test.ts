import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertPhase50EnvironmentCoverageClosed } from "../../src/verification/phase50-conformance.js";
import { runPhase50SandboxConformance } from "../../src/verification/phase50-sandbox-conformance.js";

const enabled = process.env.PHASE50_SANDBOX_CONFORMANCE === "1";

void describe("Phase 50-2 sandbox runtime conformance", () => {
  void it(
    "records the real Docker runtime and proves required enforcement or an explicit coverage route",
    { skip: enabled ? false : "set PHASE50_SANDBOX_CONFORMANCE=1 in the production-compatible sandbox environment" },
    async () => {
      const result = await runPhase50SandboxConformance({
        configuredNetworkName: requiredEnv("AGENT_RUNNER_SANDBOX_NETWORK_NAME"),
        configuredProxyContainerName: requiredEnv("AGENT_RUNNER_SANDBOX_PROXY_CONTAINER"),
        configuredPolicyDigest: requiredEnv("PHASE50_SANDBOX_POLICY_DIGEST"),
        configuredProxyUrl: requiredEnv("AGENT_RUNNER_SANDBOX_PROXY_URL"),
        allowedProbeUrl: requiredEnv("PHASE50_SANDBOX_ALLOWED_PROBE_URL"),
        deniedProbeUrl: requiredEnv("PHASE50_SANDBOX_DENIED_PROBE_URL"),
        networkProbeImage: requiredEnv("PHASE50_SANDBOX_PROBE_IMAGE"),
      });

      assert.notEqual(result.observation.engineVersion, "unknown");
      assert.doesNotThrow(() => assertPhase50EnvironmentCoverageClosed(result.findings));
    },
  );
});

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required when PHASE50_SANDBOX_CONFORMANCE=1`);
  }
  return value;
}
