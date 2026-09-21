import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSandboxNetworkPolicy } from "../sandbox/network-policy.js";
import { BoundedUtf8Capture, SandboxResourcePolicy } from "../sandbox/resource-policy.js";
import { DockerSandboxRuntime, type DockerCommandRunner } from "../sandbox/docker-runtime.js";
import { TaskWorkspaceManager } from "../sandbox/workspace.js";
import type { PreparedExecution } from "../execution/types.js";
import type { SandboxRuntimeConfig, TaskWorkspace } from "../sandbox/types.js";
import type { Phase50ConformanceFinding } from "./phase50-conformance.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CONTAINER_ID = "c".repeat(64);
const POLICY_DIGEST_LABEL = "io.mcp.agent-runner.egress-policy-sha256";
const PROXY_ROLE_LABEL = "io.mcp.agent-runner.egress-proxy";

export interface Phase50SandboxConformanceInput {
  readonly dockerRunner?: DockerCommandRunner;
  readonly configuredNetworkName?: string;
  readonly configuredProxyContainerName?: string;
  readonly configuredPolicyDigest?: string;
  readonly configuredProxyUrl?: string;
  readonly allowedProbeUrl?: string;
  readonly deniedProbeUrl?: string;
  readonly networkProbeImage?: string;
}

export interface Phase50SandboxObservation {
  readonly engineImplementation: string;
  readonly engineVersion: string;
  readonly operatingSystem: string;
  readonly kernelVersion: string;
  readonly cgroupDriver: string;
  readonly cgroupVersion: string;
  readonly securityOptions: readonly string[];
  readonly nestedContainer: boolean;
  readonly ci: boolean;
  readonly networkObserved: boolean;
  readonly networkInternal?: boolean;
  readonly proxyObserved: boolean;
  readonly proxyRunning?: boolean;
}

export async function runPhase50SandboxConformance(
  input: Phase50SandboxConformanceInput = {},
): Promise<{
  readonly observation: Phase50SandboxObservation;
  readonly findings: readonly Phase50ConformanceFinding[];
}> {
  const docker = input.dockerRunner ?? new Phase50NodeDockerProbeRunner();
  let server: Readonly<Record<string, unknown>> = Object.freeze({});
  let info: Readonly<Record<string, unknown>> = Object.freeze({});
  let dockerProbeError: string | undefined;
  try {
    server = jsonRecord(
      await docker.run(["version", "--format", "{{json .Server}}"]),
      "Docker version server",
    );
    info = jsonRecord(
      await docker.run(["info", "--format", "{{json .}}"]),
      "Docker info",
    );
  } catch (error) {
    dockerProbeError = errorMessage(error);
  }

  const networkObservation = await observeNetwork(docker, input);
  const outputEvidence = measureOutputCaptureEnforcement();
  const diskEvidence = await measureWorkspaceDiskEnforcement();
  const timeoutEvidence = await measureExecutionTimeoutEnforcement();
  const lifecycleEvidence = await measureLifecycleEnforcementThroughProductionRuntime();

  const observation = Object.freeze({
    engineImplementation: textOrUnknown(optionalRecord(server.Platform)?.Name) ?? "docker",
    engineVersion: textOrUnknown(server.Version) ?? "unknown",
    operatingSystem: textOrUnknown(info.OperatingSystem) ?? "unknown",
    kernelVersion: textOrUnknown(info.KernelVersion) ?? "unknown",
    cgroupDriver: textOrUnknown(info.CgroupDriver) ?? "unknown",
    cgroupVersion: String(numberOrUnknown(info.CgroupVersion) ?? "unknown"),
    securityOptions: Object.freeze(stringArrayOrEmpty(info.SecurityOptions)),
    nestedContainer: existsSync("/.dockerenv") || process.env.CONTAINER !== undefined,
    ci: process.env.CI === "true" || process.env.CI === "1",
    networkObserved: networkObservation.networkObserved,
    ...(networkObservation.networkInternal === undefined
      ? {}
      : { networkInternal: networkObservation.networkInternal }),
    proxyObserved: networkObservation.proxyObserved,
    ...(networkObservation.proxyRunning === undefined
      ? {}
      : { proxyRunning: networkObservation.proxyRunning }),
  });

  const networkCompatible =
    networkObservation.networkObserved &&
    networkObservation.networkInternal === true &&
    networkObservation.networkPolicyDigestMatch === true &&
    networkObservation.proxyObserved &&
    networkObservation.proxyRunning === true &&
    networkObservation.proxyManaged === true &&
    networkObservation.proxyPolicyDigestMatch === true &&
    networkObservation.proxyAttachedToNetwork === true &&
    networkObservation.enforcementMeasured === true &&
    networkObservation.directEgressDenied === true &&
    networkObservation.allowedProxyStatus === 200 &&
    networkObservation.deniedProxyStatus === 403;

  const findings: Phase50ConformanceFinding[] = [
    dockerProbeError === undefined
      ? Object.freeze({
          id: "sandbox.engine-version",
          surface: "sandbox" as const,
          requirement: "container engine implementation and version are recorded",
          classification: "compatible" as const,
          evidence: Object.freeze([
            `engine=${observation.engineImplementation}`,
            `version=${observation.engineVersion}`,
            `os=${observation.operatingSystem}`,
            `kernel=${observation.kernelVersion}`,
          ]),
        })
      : Object.freeze({
          id: "sandbox.engine-version",
          surface: "sandbox" as const,
          requirement: "container engine implementation and version are recorded",
          classification: "unsupported" as const,
          evidence: Object.freeze([`Docker runtime probe failed: ${dockerProbeError}`]),
          coverageRoute: "C" as const,
          coverageExecuted: false,
          coverageEvidence: Object.freeze([
            "execute the probe in a production-compatible Docker environment before Phase 50 coverage closure",
          ]),
        }),
    Object.freeze({
      id: "sandbox.cgroup-observation",
      surface: "sandbox",
      requirement: "cgroup/resource-control availability is recorded without inventing CPU/memory contract requirements",
      classification: "different-contract-neutral",
      evidence: Object.freeze([
        `cgroupDriver=${observation.cgroupDriver}`,
        `cgroupVersion=${observation.cgroupVersion}`,
        "current SandboxResourceLimits does not define CPU or memory quota fields",
      ]),
      coverageRoute: "E",
      coverageExecuted: true,
      coverageEvidence: Object.freeze([
        "CPU/memory are observational for Phase 50-2 because the current canonical runtime limit surface does not require them",
      ]),
    }),
    Object.freeze({
      id: "sandbox.output-capture",
      surface: "sandbox",
      requirement: "captured output is finite and truncation is observable",
      classification: "compatible",
      evidence: Object.freeze([outputEvidence]),
    }),
    Object.freeze({
      id: "sandbox.workspace-disk",
      surface: "sandbox",
      requirement: "workspace disk limit is mechanically enforced",
      classification: "compatible",
      evidence: Object.freeze([diskEvidence]),
    }),
    Object.freeze({
      id: "sandbox.execution-timeout",
      surface: "sandbox",
      requirement: "execution timeout produces an AbortSignal rather than an unbounded execution",
      classification: "compatible",
      evidence: Object.freeze([timeoutEvidence]),
    }),
    Object.freeze({
      id: "sandbox.container-lifecycle",
      surface: "sandbox",
      requirement: "container lifecycle enforcement removes the sandbox even without downstream completion",
      classification: "different-contract-affecting",
      evidence: Object.freeze([
        "lifecycle enforcement depends on Agent Runner timer semantics rather than a Docker daemon quota",
      ]),
      coverageRoute: "B",
      coverageExecuted: true,
      coverageEvidence: Object.freeze([lifecycleEvidence]),
    }),
    networkCompatible
      ? Object.freeze({
          id: "sandbox.network-policy",
          surface: "sandbox" as const,
          requirement: "configured network is internal and managed egress proxy is running",
          classification: "compatible" as const,
          evidence: Object.freeze(networkObservation.evidence),
        })
      : Object.freeze({
          id: "sandbox.network-policy",
          surface: "sandbox" as const,
          requirement: "configured network is internal and managed egress proxy is running",
          classification: "unsupported" as const,
          evidence: Object.freeze(networkObservation.evidence),
          coverageRoute: "C" as const,
          coverageExecuted: false,
          coverageEvidence: Object.freeze([
            "run the conformance probe in the production-compatible Docker/network environment before Phase 50 coverage closure",
          ]),
        }),
    Object.freeze({
      id: "sandbox.nested-container",
      surface: "sandbox",
      requirement: "nested-container and CI restrictions are recorded rather than assumed equivalent",
      classification: "different-contract-neutral",
      evidence: Object.freeze([
        `nestedContainer=${String(observation.nestedContainer)}`,
        `ci=${String(observation.ci)}`,
        `securityOptions=${observation.securityOptions.join(",")}`,
      ]),
      coverageRoute: "E",
      coverageExecuted: true,
      coverageEvidence: Object.freeze([
        "environment difference is recorded; contract-affecting network/resource semantics are covered by separate findings",
      ]),
    }),
  ];

  return Object.freeze({ observation, findings: Object.freeze(findings) });
}

export class Phase50NodeDockerProbeRunner implements DockerCommandRunner {
  async run(args: readonly string[]): Promise<string> {
    return await new Promise<string>((resolvePromise, rejectPromise) => {
      execFile("docker", [...args], { encoding: "utf8", maxBuffer: 1_048_576 }, (error, stdout) => {
        if (error !== null) {
          rejectPromise(new Error(`Docker conformance probe failed: ${args.join(" ")}`, { cause: error }));
          return;
        }
        resolvePromise(stdout);
      });
    });
  }
}

async function observeNetwork(
  docker: DockerCommandRunner,
  input: Phase50SandboxConformanceInput,
): Promise<{
  readonly networkObserved: boolean;
  readonly networkInternal?: boolean;
  readonly networkPolicyDigestMatch?: boolean;
  readonly proxyObserved: boolean;
  readonly proxyRunning?: boolean;
  readonly proxyManaged?: boolean;
  readonly proxyPolicyDigestMatch?: boolean;
  readonly proxyAttachedToNetwork?: boolean;
  readonly enforcementMeasured: boolean;
  readonly directEgressDenied?: boolean;
  readonly allowedProxyStatus?: number;
  readonly deniedProxyStatus?: number;
  readonly evidence: readonly string[];
}> {
  const networkName = input.configuredNetworkName?.trim();
  const proxyName = input.configuredProxyContainerName?.trim();
  const policyDigest = input.configuredPolicyDigest?.trim();
  const proxyUrl = input.configuredProxyUrl?.trim();
  const allowedProbeUrl = input.allowedProbeUrl?.trim();
  const deniedProbeUrl = input.deniedProbeUrl?.trim();
  const networkProbeImage = input.networkProbeImage?.trim();
  if (networkName === undefined || networkName === "" || proxyName === undefined || proxyName === "") {
    return Object.freeze({
      networkObserved: false,
      proxyObserved: false,
      enforcementMeasured: false,
      evidence: Object.freeze(["configured network/proxy names were not supplied to the conformance probe"]),
    });
  }

  const evidence: string[] = [];
  let networkInternal: boolean | undefined;
  let networkPolicyDigestMatch: boolean | undefined;
  let proxyRunning: boolean | undefined;
  let proxyManaged: boolean | undefined;
  let proxyPolicyDigestMatch: boolean | undefined;
  let proxyAttachedToNetwork: boolean | undefined;
  try {
    const network = jsonRecord(
      await docker.run(["network", "inspect", networkName, "--format", "{{json .}}"]),
      "Docker network inspect",
    );
    networkInternal = network.Internal === true;
    const labels = optionalRecord(network.Labels);
    networkPolicyDigestMatch =
      policyDigest !== undefined && policyDigest !== "" && labels?.[POLICY_DIGEST_LABEL] === policyDigest;
    evidence.push(`network=${networkName} internal=${String(networkInternal)}`);
    evidence.push(`networkPolicyDigestMatch=${String(networkPolicyDigestMatch)}`);
  } catch (error) {
    evidence.push(`network inspect failed: ${errorMessage(error)}`);
  }

  try {
    const proxy = jsonRecord(
      await docker.run(["container", "inspect", proxyName, "--format", "{{json .}}"]),
      "Docker proxy inspect",
    );
    const state = optionalRecord(proxy.State);
    const config = optionalRecord(proxy.Config);
    const labels = optionalRecord(config?.Labels);
    const networkSettings = optionalRecord(proxy.NetworkSettings);
    const networks = optionalRecord(networkSettings?.Networks);
    proxyRunning = state?.Running === true;
    proxyManaged = labels?.[PROXY_ROLE_LABEL] === "true";
    proxyPolicyDigestMatch =
      policyDigest !== undefined && policyDigest !== "" && labels?.[POLICY_DIGEST_LABEL] === policyDigest;
    proxyAttachedToNetwork = networks !== undefined && networkName in networks;
    evidence.push(`proxy=${proxyName} running=${String(proxyRunning)}`);
    evidence.push(`proxyManaged=${String(proxyManaged)}`);
    evidence.push(`proxyPolicyDigestMatch=${String(proxyPolicyDigestMatch)}`);
    evidence.push(`proxyAttachedToNetwork=${String(proxyAttachedToNetwork)}`);
  } catch (error) {
    evidence.push(`proxy inspect failed: ${errorMessage(error)}`);
  }

  let enforcementMeasured = false;
  let directEgressDenied: boolean | undefined;
  let allowedProxyStatus: number | undefined;
  let deniedProxyStatus: number | undefined;
  if (
    proxyUrl !== undefined && proxyUrl !== "" &&
    allowedProbeUrl !== undefined && allowedProbeUrl !== "" &&
    deniedProbeUrl !== undefined && deniedProbeUrl !== "" &&
    networkProbeImage !== undefined && networkProbeImage !== ""
  ) {
    try {
      const measured = jsonRecord(
        await docker.run([
          "run",
          "--rm",
          "--network",
          networkName,
          networkProbeImage,
          "node",
          "-e",
          NETWORK_ENFORCEMENT_PROBE_SCRIPT,
          allowedProbeUrl,
          proxyUrl,
          deniedProbeUrl,
        ]),
        "Phase 50 network enforcement probe",
      );
      directEgressDenied = measured.directEgressDenied === true;
      allowedProxyStatus = safeStatus(measured.allowedProxyStatus);
      deniedProxyStatus = safeStatus(measured.deniedProxyStatus);
      enforcementMeasured = true;
      evidence.push(`directEgressDenied=${String(directEgressDenied)}`);
      evidence.push(`allowedProxyStatus=${String(allowedProxyStatus)}`);
      evidence.push(`deniedProxyStatus=${String(deniedProxyStatus)}`);
    } catch (error) {
      evidence.push(`network enforcement probe failed: ${errorMessage(error)}`);
    }
  } else {
    evidence.push(
      "network enforcement URLs/proxy/image were not fully supplied; direct-deny and allow/deny proxy paths were not measured",
    );
  }

  return Object.freeze({
    networkObserved: networkInternal !== undefined,
    ...(networkInternal === undefined ? {} : { networkInternal }),
    ...(networkPolicyDigestMatch === undefined ? {} : { networkPolicyDigestMatch }),
    proxyObserved: proxyRunning !== undefined,
    ...(proxyRunning === undefined ? {} : { proxyRunning }),
    ...(proxyManaged === undefined ? {} : { proxyManaged }),
    ...(proxyPolicyDigestMatch === undefined ? {} : { proxyPolicyDigestMatch }),
    ...(proxyAttachedToNetwork === undefined ? {} : { proxyAttachedToNetwork }),
    enforcementMeasured,
    ...(directEgressDenied === undefined ? {} : { directEgressDenied }),
    ...(allowedProxyStatus === undefined ? {} : { allowedProxyStatus }),
    ...(deniedProxyStatus === undefined ? {} : { deniedProxyStatus }),
    evidence: Object.freeze(evidence),
  });
}

const NETWORK_ENFORCEMENT_PROBE_SCRIPT = String.raw`
const http = require("node:http");
const allowed = process.argv[1];
const proxy = new URL(process.argv[2]);
const denied = process.argv[3];

function requestDirect(target) {
  return new Promise((resolve) => {
    const url = new URL(target);
    const req = http.request({
      host: url.hostname,
      port: url.port || 80,
      method: "GET",
      path: url.pathname || "/",
    }, (res) => {
      res.resume();
      resolve(false);
    });
    req.setTimeout(1200, () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(true));
    req.end();
  });
}

function requestViaProxy(target) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(target);
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: "GET",
      path: target,
      headers: { Host: targetUrl.host },
    }, (res) => {
      const status = res.statusCode || 0;
      res.resume();
      resolve(status);
    });
    req.setTimeout(2000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  const directEgressDenied = await requestDirect(allowed);
  const allowedProxyStatus = await requestViaProxy(allowed);
  const deniedProxyStatus = await requestViaProxy(denied);
  process.stdout.write(JSON.stringify({ directEgressDenied, allowedProxyStatus, deniedProxyStatus }));
})().catch((error) => {
  process.stderr.write(String(error));
  process.exit(1);
});
`;

function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function measureOutputCaptureEnforcement(): string {
  const capture = new BoundedUtf8Capture(4);
  capture.append("12345678");
  const observed = capture.snapshot();
  if (observed.capturedBytes !== 4 || observed.text !== "1234" || !observed.truncated) {
    throw new Error("Phase 50 output capture enforcement measurement failed");
  }
  return "BoundedUtf8Capture limited 8 input bytes to 4 bytes and set truncated=true";
}

async function measureWorkspaceDiskEnforcement(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "phase50-workspace-conformance-"));
  try {
    const manager = new TaskWorkspaceManager({ root, diskLimitBytes: 4 });
    const workspace = await manager.create(EXECUTION_ID);
    await writeFile(join(workspace.path, "over-limit.bin"), Buffer.alloc(8, 1));
    let rejected = false;
    try {
      await workspace.assertWithinDiskLimit();
    } catch {
      rejected = true;
    }
    await workspace.dispose();
    if (!rejected) {
      throw new Error("Phase 50 workspace disk limit did not reject measured over-limit usage");
    }
    return "TaskWorkspace rejected an 8-byte file against a 4-byte configured disk limit";
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function measureExecutionTimeoutEnforcement(): Promise<string> {
  const policy = new SandboxResourcePolicy({
    executionTimeoutMs: 10,
    outputCaptureBytes: 4,
    diagnosticCaptureBytes: 4,
    workspaceDiskBytes: 4,
    containerLifecycleMs: 20,
    workspaceCheckIntervalMs: 5,
    tmpfsBytes: 4,
  });
  const signal = policy.createExecutionTimeoutSignal();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  if (!signal.aborted) {
    throw new Error("Phase 50 execution timeout signal did not abort");
  }
  return "SandboxResourcePolicy execution timeout signal aborted within the deterministic measurement window";
}

async function measureLifecycleEnforcementThroughProductionRuntime(): Promise<string> {
  const network = parseSandboxNetworkPolicy({
    policyJson: JSON.stringify({
      "agent-provider": { classification: "required", endpoints: ["https://provider.example.test"] },
      "package-registry": { classification: "denied", endpoints: [] },
      "required-runtime-dependency": { classification: "denied", endpoints: [] },
      "source-repository": { classification: "denied", endpoints: [] },
      "other-external-endpoint": { classification: "denied", endpoints: [] },
    }),
    dockerNetworkName: "phase50-internal",
    proxyContainerName: "phase50-proxy",
    proxyUrl: "http://phase50-proxy:3128",
  });
  const config: SandboxRuntimeConfig = {
    runtime: "docker",
    agentProvider: "codex-cli",
    image: `example.invalid/agent@sha256:${"a".repeat(64)}`,
    workspaceRoot: "/tmp/phase50-workspaces",
    network,
    resources: {
      executionTimeoutMs: 5,
      outputCaptureBytes: 4,
      diagnosticCaptureBytes: 4,
      workspaceDiskBytes: 1024,
      containerLifecycleMs: 15,
      workspaceCheckIntervalMs: 1000,
      tmpfsBytes: 1024,
    },
  };
  const runner = new LifecycleProbeDockerRunner(network.digest);
  const workspace = new LifecycleProbeWorkspace();
  const runtime = new DockerSandboxRuntime({ config, dockerRunner: runner });
  const handle = await runtime.create({ execution: lifecycleProbeExecution(), workspace });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
  if (!handle.enforcementSignal.aborted || !runner.removed) {
    throw new Error("Phase 50 production DockerSandboxRuntime lifecycle enforcement measurement failed");
  }
  await handle.dispose("lifecycle_limit");
  return "DockerSandboxRuntime production lifecycle timer aborted and removed the sandbox through a deterministic DockerCommandRunner seam";
}

class LifecycleProbeWorkspace implements TaskWorkspace {
  readonly executionId = EXECUTION_ID;
  readonly path = "/tmp/phase50-workspace";
  readonly diskLimitBytes = 1024;

  measureDiskUsageBytes(): Promise<number> {
    return Promise.resolve(0);
  }

  assertWithinDiskLimit(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class LifecycleProbeDockerRunner implements DockerCommandRunner {
  removed = false;
  readonly #digest: string;

  constructor(digest: string) {
    this.#digest = digest;
  }

  run(args: readonly string[]): Promise<string> {
    if (args[0] === "network" && args[1] === "inspect") {
      return Promise.resolve(JSON.stringify({ Internal: true, Labels: { [POLICY_DIGEST_LABEL]: this.#digest } }));
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === "phase50-proxy") {
      return Promise.resolve(JSON.stringify({
        State: { Running: true },
        Config: {
          Labels: {
            "io.mcp.agent-runner.egress-proxy": "true",
            [POLICY_DIGEST_LABEL]: this.#digest,
          },
        },
        NetworkSettings: { Networks: { "phase50-internal": {} } },
      }));
    }
    if (args[0] === "create") {
      return Promise.resolve(`${CONTAINER_ID}\n`);
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === CONTAINER_ID) {
      return Promise.resolve(JSON.stringify({
        HostConfig: {
          Privileged: false,
          ReadonlyRootfs: true,
          NetworkMode: "phase50-internal",
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
        },
        Config: {
          Labels: {
            "io.mcp.agent-runner.sandbox": "true",
            "io.mcp.agent-runner.execution-id": EXECUTION_ID,
            [POLICY_DIGEST_LABEL]: this.#digest,
          },
          Env: ["HTTP_PROXY=http://phase50-proxy:3128"],
        },
        Mounts: [
          { Type: "bind", Source: "/tmp/phase50-workspace", Destination: "/workspace", RW: true },
        ],
      }));
    }
    if (args[0] === "rm" && args[1] === "-f") {
      this.removed = true;
      return Promise.resolve(CONTAINER_ID);
    }
    throw new Error(`unexpected lifecycle probe Docker call: ${args.join(" ")}`);
  }
}

function lifecycleProbeExecution(): PreparedExecution {
  const pending = Object.freeze({ kind: "pending" as const });
  const approvedBriefReference = Object.freeze({
    repository: "mcp-mamono210/ai-agent-runner",
    issueId: 5426,
    briefRevision: 1,
    persistedRevision: "phase50-conformance",
  });
  const input = Object.freeze({
    executionId: EXECUTION_ID,
    issueId: 5426,
    repository: approvedBriefReference.repository,
    sourceRevision: "d".repeat(40),
    briefRevision: 1,
    persistedRevision: "phase50-conformance",
    requirementsFingerprint: `sha256:${"e".repeat(64)}`,
    approvedBriefReference,
  });
  return Object.freeze({
    issue: { issueId: 5426, projectId: 414, lifecycle: "Ready for Agent", raw: {} },
    handoff: {
      issueId: 5426,
      repository: input.repository,
      approvedRequirementsFingerprint: input.requirementsFingerprint,
      opaque: {},
    },
    input,
    record: Object.freeze({
      executionId: input.executionId,
      issueId: input.issueId,
      briefRevision: input.briefRevision,
      persistedRevision: input.persistedRevision,
      requirementsFingerprint: input.requirementsFingerprint,
      repository: input.repository,
      sourceRevision: input.sourceRevision,
      startedAt: "2026-09-21T00:00:00.000Z",
      finishedAt: pending,
      outcome: pending,
      artifactReference: pending,
    }),
  });
}

function jsonRecord(raw: string, label: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} did not return an object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function optionalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function textOrUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function numberOrUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayOrEmpty(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
