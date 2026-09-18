import { execFile } from "node:child_process";

import type { PreparedExecution } from "../execution/types.js";
import type {
  ResolvedSandboxNetworkPolicy,
  SandboxDisposalReason,
  SandboxHandle,
  SandboxInspection,
  SandboxResourceLimits,
  SandboxRuntime,
  SandboxRuntimeConfig,
  TaskWorkspace,
} from "./types.js";

const NETWORK_POLICY_DIGEST_LABEL = "io.mcp.agent-runner.egress-policy-sha256";
const EGRESS_PROXY_ROLE_LABEL = "io.mcp.agent-runner.egress-proxy";
const EXECUTION_ID_LABEL = "io.mcp.agent-runner.execution-id";
const SANDBOX_ROLE_LABEL = "io.mcp.agent-runner.sandbox";
const WORKSPACE_DESTINATION = "/workspace";
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/u;
const FORBIDDEN_AGENT_ENV_NAMES = new Set([
  "REDMINE_API_KEY",
  "REDMINE_WRITE_API_KEY",
  "CONTROL_PLANE_API_KEY",
  "AGENT_RUNNER_GIT_USERNAME",
  "AGENT_RUNNER_GIT_READ_TOKEN",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
]);

export interface DockerCommandRunner {
  run(args: readonly string[]): Promise<string>;
}

export class NodeDockerCommandRunner implements DockerCommandRunner {
  async run(args: readonly string[]): Promise<string> {
    return await new Promise<string>((resolvePromise, rejectPromise) => {
      execFile(
        "docker",
        [...args],
        { encoding: "utf8", maxBuffer: 1_048_576 },
        (error, stdout) => {
          if (error !== null) {
            rejectPromise(new Error("Docker runtime operation failed", { cause: error }));
            return;
          }
          resolvePromise(stdout);
        },
      );
    });
  }
}

export class DockerSandboxRuntime implements SandboxRuntime {
  readonly #config: SandboxRuntimeConfig;
  readonly #docker: DockerCommandRunner;

  constructor(input: {
    readonly config: SandboxRuntimeConfig;
    readonly dockerRunner?: DockerCommandRunner;
  }) {
    this.#config = input.config;
    this.#docker = input.dockerRunner ?? new NodeDockerCommandRunner();
  }

  async create(input: {
    readonly execution: PreparedExecution;
    readonly workspace: TaskWorkspace;
  }): Promise<SandboxHandle> {
    if (input.workspace.executionId !== input.execution.input.executionId) {
      throw new Error("sandbox workspace execution identity mismatch");
    }
    await input.workspace.assertWithinDiskLimit();
    await verifyManagedEgressBoundary(this.#docker, this.#config.network);

    const containerId = await this.#createContainer(input.execution, input.workspace);
    try {
      await verifySandboxIsolation({
        docker: this.#docker,
        containerId,
        executionId: input.execution.input.executionId,
        workspace: input.workspace,
        network: this.#config.network,
      });
    } catch (error) {
      await bestEffortRemove(this.#docker, containerId);
      throw error;
    }

    return new DockerSandboxHandle({
      docker: this.#docker,
      containerId,
      executionId: input.execution.input.executionId,
      workspace: input.workspace,
      network: this.#config.network,
      resources: this.#config.resources,
    });
  }

  async #createContainer(
    execution: PreparedExecution,
    workspace: TaskWorkspace,
  ): Promise<string> {
    const name = `agent-runner-${execution.input.executionId}`;
    const proxyUrl = this.#config.network.proxyUrl;
    const args = [
      "create",
      "--name",
      name,
      "--init",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--network",
      this.#config.network.dockerNetworkName,
      "--label",
      `${SANDBOX_ROLE_LABEL}=true`,
      "--label",
      `${EXECUTION_ID_LABEL}=${execution.input.executionId}`,
      "--label",
      `${NETWORK_POLICY_DIGEST_LABEL}=${this.#config.network.digest}`,
      "--mount",
      `type=bind,src=${workspace.path},dst=${WORKSPACE_DESTINATION},rw`,
      "--tmpfs",
      `/tmp:rw,nosuid,nodev,noexec,size=${this.#config.resources.tmpfsBytes}`,
      "--workdir",
      WORKSPACE_DESTINATION,
      "--env",
      `HTTP_PROXY=${proxyUrl}`,
      "--env",
      `HTTPS_PROXY=${proxyUrl}`,
      "--env",
      `http_proxy=${proxyUrl}`,
      "--env",
      `https_proxy=${proxyUrl}`,
      "--env",
      "NO_PROXY=localhost,127.0.0.1,::1",
      "--env",
      "no_proxy=localhost,127.0.0.1,::1",
      "--entrypoint",
      "sleep",
      this.#config.image,
      "infinity",
    ];
    const output = (await this.#docker.run(args)).trim();
    if (!CONTAINER_ID_PATTERN.test(output)) {
      throw new Error("Docker create did not return a valid container ID");
    }
    return output;
  }
}

class DockerSandboxHandle implements SandboxHandle {
  readonly containerId: string;
  readonly executionId: string;
  readonly workspace: TaskWorkspace;
  readonly resources: SandboxResourceLimits;
  readonly enforcementSignal: AbortSignal;
  readonly #docker: DockerCommandRunner;
  readonly #network: ResolvedSandboxNetworkPolicy;
  readonly #abortController = new AbortController();
  readonly #lifecycleTimer: NodeJS.Timeout;
  readonly #workspaceTimer: NodeJS.Timeout;
  #disposed = false;
  #containerRemoved = false;
  #removalPromise: Promise<void> | undefined;

  constructor(input: {
    readonly docker: DockerCommandRunner;
    readonly containerId: string;
    readonly executionId: string;
    readonly workspace: TaskWorkspace;
    readonly network: ResolvedSandboxNetworkPolicy;
    readonly resources: SandboxResourceLimits;
  }) {
    this.#docker = input.docker;
    this.containerId = input.containerId;
    this.executionId = input.executionId;
    this.workspace = input.workspace;
    this.#network = input.network;
    this.resources = input.resources;
    this.enforcementSignal = this.#abortController.signal;

    this.#lifecycleTimer = setTimeout(() => {
      void this.#abortAndRemove(
        "lifecycle_limit",
        new Error("sandbox container lifecycle limit exceeded"),
      );
    }, input.resources.containerLifecycleMs);
    this.#lifecycleTimer.unref();

    this.#workspaceTimer = setInterval(() => {
      void this.#pollWorkspaceDisk();
    }, input.resources.workspaceCheckIntervalMs);
    this.#workspaceTimer.unref();
  }

  async inspectIsolation(): Promise<SandboxInspection> {
    if (this.#disposed) {
      throw new Error("sandbox has already been disposed");
    }
    return await verifySandboxIsolation({
      docker: this.#docker,
      containerId: this.containerId,
      executionId: this.executionId,
      workspace: this.workspace,
      network: this.#network,
    });
  }

  async dispose(reason: SandboxDisposalReason): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    clearTimeout(this.#lifecycleTimer);
    clearInterval(this.#workspaceTimer);
    if (!this.#abortController.signal.aborted) {
      this.#abortController.abort(new Error(`sandbox disposed: ${reason}`));
    }

    const errors: unknown[] = [];
    try {
      await this.#removeContainer();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.workspace.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "sandbox disposal failed");
    }
  }

  async #pollWorkspaceDisk(): Promise<void> {
    if (this.#disposed || this.#abortController.signal.aborted) {
      return;
    }
    try {
      await this.workspace.assertWithinDiskLimit();
    } catch (error) {
      await this.#abortAndRemove(
        "workspace_disk_limit",
        error instanceof Error ? error : new Error("workspace disk enforcement failed"),
      );
    }
  }

  async #abortAndRemove(
    reason: SandboxDisposalReason,
    error: Error,
  ): Promise<void> {
    if (this.#disposed) {
      return;
    }
    if (!this.#abortController.signal.aborted) {
      this.#abortController.abort(error);
    }
    clearTimeout(this.#lifecycleTimer);
    clearInterval(this.#workspaceTimer);
    try {
      await this.#removeContainer();
    } catch {
      if (!this.#abortController.signal.aborted) {
        this.#abortController.abort(new Error(`sandbox ${reason} enforcement failed`));
      }
    }
  }

  async #removeContainer(): Promise<void> {
    if (this.#containerRemoved) {
      return;
    }
    if (this.#removalPromise !== undefined) {
      await this.#removalPromise;
      return;
    }
    this.#removalPromise = this.#docker.run(["rm", "-f", this.containerId]).then(() => {
      this.#containerRemoved = true;
    });
    await this.#removalPromise;
  }
}

async function verifyManagedEgressBoundary(
  docker: DockerCommandRunner,
  network: ResolvedSandboxNetworkPolicy,
): Promise<void> {
  const networkInspect = parseJsonObject(
    await docker.run([
      "network",
      "inspect",
      network.dockerNetworkName,
      "--format",
      "{{json .}}",
    ]),
    "Docker network inspect",
  );
  if (networkInspect.Internal !== true) {
    throw new Error("sandbox Docker network must be internal to prevent direct unrestricted egress");
  }
  const networkLabels = stringRecord(networkInspect.Labels, "Docker network labels");
  if (networkLabels[NETWORK_POLICY_DIGEST_LABEL] !== network.digest) {
    throw new Error("sandbox Docker network policy digest does not match resolved policy");
  }

  const proxyInspect = parseJsonObject(
    await docker.run([
      "container",
      "inspect",
      network.proxyContainerName,
      "--format",
      "{{json .}}",
    ]),
    "Docker proxy inspect",
  );
  const state = objectValue(proxyInspect.State, "Docker proxy state");
  if (state.Running !== true) {
    throw new Error("sandbox egress proxy container is not running");
  }
  const config = objectValue(proxyInspect.Config, "Docker proxy config");
  const proxyLabels = stringRecord(config.Labels, "Docker proxy labels");
  if (proxyLabels[EGRESS_PROXY_ROLE_LABEL] !== "true") {
    throw new Error("configured Docker proxy container is not marked as managed egress proxy");
  }
  if (proxyLabels[NETWORK_POLICY_DIGEST_LABEL] !== network.digest) {
    throw new Error("sandbox egress proxy policy digest does not match resolved policy");
  }
  const networkSettings = objectValue(
    proxyInspect.NetworkSettings,
    "Docker proxy network settings",
  );
  const networks = objectValue(networkSettings.Networks, "Docker proxy networks");
  if (!(network.dockerNetworkName in networks)) {
    throw new Error("sandbox egress proxy is not attached to the managed internal network");
  }
}

async function verifySandboxIsolation(input: {
  readonly docker: DockerCommandRunner;
  readonly containerId: string;
  readonly executionId: string;
  readonly workspace: TaskWorkspace;
  readonly network: ResolvedSandboxNetworkPolicy;
}): Promise<SandboxInspection> {
  const inspected = parseJsonObject(
    await input.docker.run([
      "container",
      "inspect",
      input.containerId,
      "--format",
      "{{json .}}",
    ]),
    "Docker sandbox inspect",
  );
  const hostConfig = objectValue(inspected.HostConfig, "Docker sandbox HostConfig");
  if (hostConfig.Privileged !== false) {
    throw new Error("Agent sandbox must not be privileged");
  }
  if (hostConfig.ReadonlyRootfs !== true) {
    throw new Error("Agent sandbox root filesystem must be read-only");
  }
  if (hostConfig.NetworkMode !== input.network.dockerNetworkName) {
    throw new Error("Agent sandbox is attached to an unexpected Docker network");
  }
  const capDrop = stringArray(hostConfig.CapDrop, "Docker sandbox CapDrop");
  if (!capDrop.includes("ALL")) {
    throw new Error("Agent sandbox must drop all Linux capabilities");
  }
  const securityOpt = stringArray(hostConfig.SecurityOpt, "Docker sandbox SecurityOpt");
  if (!securityOpt.some((entry) => entry.startsWith("no-new-privileges"))) {
    throw new Error("Agent sandbox must enable no-new-privileges");
  }

  const config = objectValue(inspected.Config, "Docker sandbox Config");
  const labels = stringRecord(config.Labels, "Docker sandbox labels");
  if (labels[SANDBOX_ROLE_LABEL] !== "true") {
    throw new Error("Docker container is not marked as Agent Runner sandbox");
  }
  if (labels[EXECUTION_ID_LABEL] !== input.executionId) {
    throw new Error("Docker sandbox execution identity mismatch");
  }
  if (labels[NETWORK_POLICY_DIGEST_LABEL] !== input.network.digest) {
    throw new Error("Docker sandbox network policy digest mismatch");
  }
  assertNoForbiddenAgentEnvironment(stringArray(config.Env, "Docker sandbox Env"));

  const mounts = arrayValue(inspected.Mounts, "Docker sandbox Mounts").map((raw, index) =>
    objectValue(raw, `Docker sandbox Mounts[${index}]`),
  );
  const hostBacked = mounts.filter((mount) => mount.Type === "bind" || mount.Type === "volume");
  if (hostBacked.length !== 1) {
    throw new Error("task-scoped workspace must be the only host-backed sandbox mount");
  }
  const workspaceMount = hostBacked[0]!;
  if (
    workspaceMount.Type !== "bind" ||
    workspaceMount.Source !== input.workspace.path ||
    workspaceMount.Destination !== WORKSPACE_DESTINATION ||
    workspaceMount.RW !== true
  ) {
    throw new Error("Agent sandbox writable mount is not the exact task-scoped workspace");
  }
  for (const mount of mounts) {
    const source = typeof mount.Source === "string" ? mount.Source : "";
    const destination = typeof mount.Destination === "string" ? mount.Destination : "";
    if (source.includes("docker.sock") || destination.includes("docker.sock")) {
      throw new Error("Docker/container-engine control socket must not be mounted into Agent sandbox");
    }
  }

  return Object.freeze({
    containerId: input.containerId,
    workspaceSource: input.workspace.path,
    workspaceDestination: WORKSPACE_DESTINATION,
    networkName: input.network.dockerNetworkName,
    policyDigest: input.network.digest,
  });
}

function assertNoForbiddenAgentEnvironment(entries: readonly string[]): void {
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const name = separator < 0 ? entry : entry.slice(0, separator);
    if (FORBIDDEN_AGENT_ENV_NAMES.has(name)) {
      throw new Error(`forbidden Controller credential environment exposed to Agent: ${name}`);
    }
  }
}

async function bestEffortRemove(
  docker: DockerCommandRunner,
  containerId: string,
): Promise<void> {
  try {
    await docker.run(["rm", "-f", containerId]);
  } catch {
    // The original isolation failure remains authoritative.
  }
}

function parseJsonObject(output: string, path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new Error(`${path} returned invalid JSON`);
  }
  return objectValue(value, path);
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value;
}

function stringArray(value: unknown, path: string): readonly string[] {
  const values = arrayValue(value, path);
  const output: string[] = [];
  for (const entry of values) {
    if (typeof entry !== "string") {
      throw new Error(`${path} must be a string array`);
    }
    output.push(entry);
  }
  return output;
}

function stringRecord(value: unknown, path: string): Readonly<Record<string, string>> {
  const record = objectValue(value, path);
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      throw new Error(`${path} must contain string values`);
    }
    output[key] = entry;
  }
  return output;
}
