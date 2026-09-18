import type { PreparedExecution } from "../execution/types.js";
import type { RepositoryCheckoutResult } from "../repository/types.js";

export const SANDBOX_RUNTIME = "docker";
export const AGENT_PROVIDER = "codex-cli";

export const NETWORK_ENDPOINT_CATEGORIES = [
  "agent-provider",
  "package-registry",
  "required-runtime-dependency",
  "source-repository",
  "other-external-endpoint",
] as const;

export type NetworkEndpointCategory = (typeof NETWORK_ENDPOINT_CATEGORIES)[number];
export type ResolvedNetworkClassification = "required" | "allowed" | "denied";

export interface ResolvedNetworkCategoryPolicy {
  readonly category: NetworkEndpointCategory;
  readonly classification: ResolvedNetworkClassification;
  readonly endpoints: readonly string[];
}

export interface ResolvedSandboxNetworkPolicy {
  readonly categories: readonly ResolvedNetworkCategoryPolicy[];
  readonly digest: string;
  readonly dockerNetworkName: string;
  readonly proxyContainerName: string;
  readonly proxyUrl: string;
}

export interface SandboxResourceLimits {
  readonly executionTimeoutMs: number;
  readonly outputCaptureBytes: number;
  readonly diagnosticCaptureBytes: number;
  readonly workspaceDiskBytes: number;
  readonly containerLifecycleMs: number;
  readonly workspaceCheckIntervalMs: number;
  readonly tmpfsBytes: number;
}

export interface SandboxRuntimeConfig {
  readonly runtime: typeof SANDBOX_RUNTIME;
  readonly agentProvider: typeof AGENT_PROVIDER;
  readonly image: string;
  readonly workspaceRoot: string;
  readonly network: ResolvedSandboxNetworkPolicy;
  readonly resources: SandboxResourceLimits;
}

export interface TaskWorkspace {
  readonly executionId: string;
  readonly path: string;
  readonly diskLimitBytes: number;
  measureDiskUsageBytes(): Promise<number>;
  assertWithinDiskLimit(): Promise<void>;
  dispose(): Promise<void>;
}

export type SandboxDisposalReason =
  | "success"
  | "failure"
  | "timeout"
  | "interruption"
  | "lifecycle_limit"
  | "workspace_disk_limit";

export interface SandboxInspection {
  readonly containerId: string;
  readonly workspaceSource: string;
  readonly workspaceDestination: "/workspace";
  readonly networkName: string;
  readonly policyDigest: string;
}

export interface SandboxHandle {
  readonly containerId: string;
  readonly executionId: string;
  readonly workspace: TaskWorkspace;
  readonly resources: SandboxResourceLimits;
  readonly enforcementSignal: AbortSignal;
  inspectIsolation(): Promise<SandboxInspection>;
  dispose(reason: SandboxDisposalReason): Promise<void>;
}

export interface SandboxRuntime {
  create(input: {
    readonly execution: PreparedExecution;
    readonly workspace: TaskWorkspace;
  }): Promise<SandboxHandle>;
}

export interface PreparedSandboxExecution {
  readonly execution: PreparedExecution;
  readonly workspace: TaskWorkspace;
  readonly checkout: RepositoryCheckoutResult;
  readonly sandbox: SandboxHandle;
}

export interface SandboxPreparedHandler {
  handle(input: PreparedSandboxExecution): Promise<SandboxDisposalReason>;
}

export interface SandboxPreparationFailureHandler {
  handle(input: {
    readonly execution: PreparedExecution;
    readonly error: unknown;
  }): Promise<void>;
}
