import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  assertPhase50EnvironmentCoverageClosed,
  parsePhase50ConformanceRecord,
  validatePhase50ConformanceFinding,
  type Phase50ConformanceFinding,
} from "../../src/verification/phase50-conformance.js";
import {
  assertNoExpectedFailureMarkers,
  assertPhase50GoldenContractMatches,
  parsePhase50ExpectedFailureRegistry,
  parsePhase50GoldenContract,
} from "../../src/verification/phase50-contract-baseline.js";
import {
  PHASE50_FAULT_IDS,
  PHASE50_SCENARIO_IDS,
} from "../../src/verification/phase50-harness.js";
import { runPhase50SandboxConformance } from "../../src/verification/phase50-sandbox-conformance.js";
import type { DockerCommandRunner } from "../../src/sandbox/docker-runtime.js";

void describe("Phase 50-2 conformance and coverage matrix", () => {
  void it("enforces the Phase 50-1 entry gate before building later harness coverage", () => {
    const gate = loadJson("docs/verification/phase50-entry-gate.json");
    if (!isRecord(gate)) {
      throw new Error("Phase 50 entry gate must be an object");
    }
    const phase50_1 = asRecord(gate.phase50_1);
    assert.equal(phase50_1.issueId, 5425);
    assert.equal(phase50_1.status, "closed");
    assert.equal(phase50_1.mergeRevision, "aa60d3fb044a786fa35763f531d4d5db7b9a919d");
    assert.deepEqual(gate.openBlockingDefectIssueIds, []);

    const golden = parsePhase50GoldenContract(loadJson("docs/contracts/phase50-contract-baseline.json"));
    assert.doesNotThrow(() => assertPhase50GoldenContractMatches(golden));

    const expectedFailures = parsePhase50ExpectedFailureRegistry(
      loadJson("docs/verification/phase50-expected-failures.json"),
    );
    assert.doesNotThrow(() => assertNoExpectedFailureMarkers(expectedFailures));
  });
  void it("requires A-D coverage for contract-affecting differences", () => {
    const unresolved: Phase50ConformanceFinding = {
      id: "s3.example",
      surface: "s3",
      requirement: "example",
      classification: "unsupported",
      evidence: ["not supported by emulator"],
      coverageRoute: "B",
      coverageExecuted: false,
      coverageEvidence: ["planned integration verification"],
    };
    assert.throws(
      () => validatePhase50ConformanceFinding(unresolved),
      /planned but not executed/u,
    );

    const resolved: Phase50ConformanceFinding = {
      ...unresolved,
      coverageExecuted: true,
      coverageEvidence: ["production-equivalent integration gate passed"],
    };
    assert.doesNotThrow(() => validatePhase50ConformanceFinding(resolved));
  });

  void it("permits route E only for a measured contract-neutral difference", () => {
    assert.doesNotThrow(() => validatePhase50ConformanceFinding({
      id: "sandbox.example",
      surface: "sandbox",
      requirement: "example",
      classification: "different-contract-neutral",
      evidence: ["normalization differs"],
      coverageRoute: "E",
      coverageExecuted: true,
      coverageEvidence: ["required contract round-trip assertions pass"],
    }));

    assert.throws(() => validatePhase50ConformanceFinding({
      id: "sandbox.bad",
      surface: "sandbox",
      requirement: "example",
      classification: "different-contract-affecting",
      evidence: ["required behavior differs"],
      coverageRoute: "E",
      coverageExecuted: true,
      coverageEvidence: ["incorrect route"],
    }), /coverage route A-D/u);
  });

  void it("fails a report with silently skipped mandatory semantics", () => {
    assert.throws(() => assertPhase50EnvironmentCoverageClosed([{
      id: "s3.required",
      surface: "s3",
      requirement: "conditional write",
      classification: "unsupported",
      evidence: ["unsupported"],
      coverageRoute: "C",
      coverageExecuted: false,
      coverageEvidence: ["not run yet"],
    }]), /planned but not executed/u);
  });

  void it("parses only closed persisted conformance records", () => {
    const parsed = parsePhase50ConformanceRecord({
      schemaVersion: 1,
      testedGitRevision: "a".repeat(40),
      generatedAt: "2026-09-21T00:00:00.000Z",
      findings: [{
        id: "sandbox.ok",
        surface: "sandbox",
        requirement: "bounded output",
        classification: "compatible",
        evidence: ["measured"],
      }],
    });
    assert.equal(parsed.findings.length, 1);
  });

  void it("keeps the forward and reverse coverage matrix complete", () => {
    const raw: unknown = JSON.parse(
      readFileSync(resolve("docs/contracts/phase50-verification-matrix.json"), "utf8"),
    ) as unknown;
    if (!isRecord(raw)) {
      throw new Error("phase50 verification matrix must be an object");
    }
    const faults = asRecord(raw.faults);
    const scenarios = asRecord(raw.scenarios);
    const reverse = raw.reverseCoverage;
    if (!Array.isArray(reverse)) {
      throw new Error("reverseCoverage must be an array");
    }
    const reverseEntries: readonly unknown[] = reverse;

    assert.deepEqual(Object.keys(faults).sort(), [...PHASE50_FAULT_IDS].sort());
    assert.deepEqual(Object.keys(scenarios).sort(), [...PHASE50_SCENARIO_IDS].sort());
    for (const id of [...PHASE50_FAULT_IDS, ...PHASE50_SCENARIO_IDS]) {
      assert.ok(
        reverseEntries.some((entry: unknown) =>
          isRecord(entry) && Array.isArray(entry.controls) && entry.controls.includes(id),
        ),
        id,
      );
    }
  });

  void it("keeps sandbox network coverage unresolved without measured allow/deny traffic", async () => {
    const result = await runPhase50SandboxConformance({
      dockerRunner: new FakeDockerEnvironment(),
      configuredNetworkName: "agent-runner-egress",
      configuredProxyContainerName: "agent-runner-egress-proxy",
      configuredPolicyDigest: "digest",
    });

    const network = result.findings.find((finding) => finding.id === "sandbox.network-policy");
    assert.equal(network?.classification, "unsupported");
    assert.equal(network?.coverageExecuted, false);
    assert.throws(() => assertPhase50EnvironmentCoverageClosed(result.findings), /planned but not executed/u);
  });

  void it("measures sandbox enforcement instead of treating config parsing as proof", async () => {
    const result = await runPhase50SandboxConformance({
      dockerRunner: new FakeDockerEnvironment(),
      configuredNetworkName: "agent-runner-egress",
      configuredProxyContainerName: "agent-runner-egress-proxy",
      configuredPolicyDigest: "digest",
      configuredProxyUrl: "http://agent-runner-egress-proxy:3128",
      allowedProbeUrl: "http://phase50-allowed-origin:8080",
      deniedProbeUrl: "http://phase50-denied-origin:8080",
      networkProbeImage: "node:24.19.0-alpine3.24",
    });

    const byId = new Map(result.findings.map((finding) => [finding.id, finding]));
    assert.equal(byId.get("sandbox.output-capture")?.classification, "compatible");
    assert.equal(byId.get("sandbox.workspace-disk")?.classification, "compatible");
    assert.equal(byId.get("sandbox.execution-timeout")?.classification, "compatible");
    assert.equal(byId.get("sandbox.container-lifecycle")?.coverageRoute, "B");
    assert.equal(byId.get("sandbox.container-lifecycle")?.coverageExecuted, true);
    assert.equal(byId.get("sandbox.network-policy")?.classification, "compatible");
    assert.doesNotThrow(() => assertPhase50EnvironmentCoverageClosed(result.findings));
  });
});

class FakeDockerEnvironment implements DockerCommandRunner {
  run(args: readonly string[]): Promise<string> {
    if (args[0] === "version") {
      return Promise.resolve(JSON.stringify({ Platform: { Name: "Docker Engine" }, Version: "27.0.0" }));
    }
    if (args[0] === "info") {
      return Promise.resolve(JSON.stringify({
        OperatingSystem: "Linux",
        KernelVersion: "6.8.0",
        CgroupDriver: "systemd",
        CgroupVersion: 2,
        SecurityOptions: ["name=seccomp"],
      }));
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return Promise.resolve(JSON.stringify({
        Internal: true,
        Labels: { "io.mcp.agent-runner.egress-policy-sha256": "digest" },
      }));
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return Promise.resolve(JSON.stringify({
        State: { Running: true },
        Config: {
          Labels: {
            "io.mcp.agent-runner.egress-proxy": "true",
            "io.mcp.agent-runner.egress-policy-sha256": "digest",
          },
        },
        NetworkSettings: { Networks: { "agent-runner-egress": {} } },
      }));
    }
    if (args[0] === "run") {
      return Promise.resolve(JSON.stringify({
        directEgressDenied: true,
        allowedProxyStatus: 200,
        deniedProxyStatus: 403,
      }));
    }
    throw new Error(`unexpected Docker probe call: ${args.join(" ")}`);
  }
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error("expected object");
  }
  return value;
}
