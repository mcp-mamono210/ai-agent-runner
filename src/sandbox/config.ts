import { isAbsolute, resolve } from "node:path";

import { parseSandboxNetworkPolicy } from "./network-policy.js";
import {
  AGENT_PROVIDER,
  SANDBOX_RUNTIME,
  type SandboxResourceLimits,
  type SandboxRuntimeConfig,
} from "./types.js";

type Environment = Readonly<Record<string, string | undefined>>;

const PINNED_IMAGE_PATTERN = /^[^\s@]+@sha256:[0-9a-f]{64}$/u;

export function loadSandboxRuntimeConfig(
  env: Environment = process.env,
): SandboxRuntimeConfig {
  const runtime = requiredValue(env.AGENT_RUNNER_SANDBOX_RUNTIME, "AGENT_RUNNER_SANDBOX_RUNTIME");
  if (runtime !== SANDBOX_RUNTIME) {
    throw new Error(`AGENT_RUNNER_SANDBOX_RUNTIME must be ${SANDBOX_RUNTIME}`);
  }
  const agentProvider = requiredValue(
    env.AGENT_RUNNER_AGENT_PROVIDER,
    "AGENT_RUNNER_AGENT_PROVIDER",
  );
  if (agentProvider !== AGENT_PROVIDER) {
    throw new Error(`AGENT_RUNNER_AGENT_PROVIDER must be ${AGENT_PROVIDER}`);
  }
  const image = requiredValue(env.AGENT_RUNNER_SANDBOX_IMAGE, "AGENT_RUNNER_SANDBOX_IMAGE");
  if (!PINNED_IMAGE_PATTERN.test(image)) {
    throw new Error("AGENT_RUNNER_SANDBOX_IMAGE must be pinned by sha256 digest");
  }
  const workspaceRoot = parseWorkspaceRoot(env.AGENT_RUNNER_WORKSPACE_ROOT);
  const resources = parseResourceLimits(env);
  if (resources.containerLifecycleMs <= resources.executionTimeoutMs) {
    throw new Error("container lifecycle limit must be greater than execution timeout");
  }

  return Object.freeze({
    runtime: SANDBOX_RUNTIME,
    agentProvider: AGENT_PROVIDER,
    image,
    workspaceRoot,
    network: parseSandboxNetworkPolicy({
      policyJson: env.AGENT_RUNNER_SANDBOX_NETWORK_POLICY_JSON,
      dockerNetworkName: env.AGENT_RUNNER_SANDBOX_NETWORK_NAME,
      proxyContainerName: env.AGENT_RUNNER_SANDBOX_PROXY_CONTAINER,
      proxyUrl: env.AGENT_RUNNER_SANDBOX_PROXY_URL,
    }),
    resources,
  });
}

export function parseResourceLimits(env: Environment): SandboxResourceLimits {
  return Object.freeze({
    executionTimeoutMs: positiveSafeInteger(
      env.AGENT_RUNNER_EXECUTION_TIMEOUT_MS,
      "AGENT_RUNNER_EXECUTION_TIMEOUT_MS",
    ),
    outputCaptureBytes: positiveSafeInteger(
      env.AGENT_RUNNER_OUTPUT_CAPTURE_BYTES,
      "AGENT_RUNNER_OUTPUT_CAPTURE_BYTES",
    ),
    diagnosticCaptureBytes: positiveSafeInteger(
      env.AGENT_RUNNER_DIAGNOSTIC_CAPTURE_BYTES,
      "AGENT_RUNNER_DIAGNOSTIC_CAPTURE_BYTES",
    ),
    workspaceDiskBytes: positiveSafeInteger(
      env.AGENT_RUNNER_WORKSPACE_DISK_BYTES,
      "AGENT_RUNNER_WORKSPACE_DISK_BYTES",
    ),
    containerLifecycleMs: positiveSafeInteger(
      env.AGENT_RUNNER_CONTAINER_LIFECYCLE_MS,
      "AGENT_RUNNER_CONTAINER_LIFECYCLE_MS",
    ),
    workspaceCheckIntervalMs: positiveSafeInteger(
      env.AGENT_RUNNER_WORKSPACE_CHECK_INTERVAL_MS,
      "AGENT_RUNNER_WORKSPACE_CHECK_INTERVAL_MS",
    ),
    tmpfsBytes: positiveSafeInteger(
      env.AGENT_RUNNER_SANDBOX_TMPFS_BYTES,
      "AGENT_RUNNER_SANDBOX_TMPFS_BYTES",
    ),
  });
}

function parseWorkspaceRoot(value: string | undefined): string {
  const raw = requiredValue(value, "AGENT_RUNNER_WORKSPACE_ROOT");
  if (!isAbsolute(raw)) {
    throw new Error("AGENT_RUNNER_WORKSPACE_ROOT must be absolute");
  }
  const normalized = resolve(raw);
  if (normalized === "/") {
    throw new Error("AGENT_RUNNER_WORKSPACE_ROOT must not be host root");
  }
  return normalized;
}

function positiveSafeInteger(value: string | undefined, name: string): number {
  const raw = requiredValue(value, name);
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function requiredValue(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}
