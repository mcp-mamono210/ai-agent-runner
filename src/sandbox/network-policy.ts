import { createHash } from "node:crypto";

import {
  NETWORK_ENDPOINT_CATEGORIES,
  type NetworkEndpointCategory,
  type ResolvedNetworkCategoryPolicy,
  type ResolvedNetworkClassification,
  type ResolvedSandboxNetworkPolicy,
} from "./types.js";

type NetworkPolicyObject = Readonly<Record<string, unknown>>;

const DOCKER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function parseSandboxNetworkPolicy(input: {
  readonly policyJson: string | undefined;
  readonly dockerNetworkName: string | undefined;
  readonly proxyContainerName: string | undefined;
  readonly proxyUrl: string | undefined;
}): ResolvedSandboxNetworkPolicy {
  const policyJson = requiredNonBlank(input.policyJson, "AGENT_RUNNER_SANDBOX_NETWORK_POLICY_JSON");
  let decoded: unknown;
  try {
    decoded = JSON.parse(policyJson) as unknown;
  } catch {
    throw new Error("AGENT_RUNNER_SANDBOX_NETWORK_POLICY_JSON must contain valid JSON");
  }
  const root = asObject(decoded, "sandbox network policy");
  const keys = Object.keys(root);
  if (
    keys.length !== NETWORK_ENDPOINT_CATEGORIES.length ||
    NETWORK_ENDPOINT_CATEGORIES.some((category) => !(category in root))
  ) {
    throw new Error("sandbox network policy must resolve all five Phase 47 endpoint categories exactly once");
  }

  const categories = NETWORK_ENDPOINT_CATEGORIES.map((category) =>
    parseCategory(category, root[category]),
  );
  enforceV04CodexPolicy(categories);

  const dockerNetworkName = requiredDockerName(
    input.dockerNetworkName,
    "AGENT_RUNNER_SANDBOX_NETWORK_NAME",
  );
  if (dockerNetworkName === "bridge" || dockerNetworkName === "host" || dockerNetworkName === "none") {
    throw new Error("sandbox network must be a dedicated managed Docker network");
  }
  const proxyContainerName = requiredDockerName(
    input.proxyContainerName,
    "AGENT_RUNNER_SANDBOX_PROXY_CONTAINER",
  );
  const proxyUrl = validateProxyUrl(
    requiredNonBlank(input.proxyUrl, "AGENT_RUNNER_SANDBOX_PROXY_URL"),
    proxyContainerName,
  );
  const digest = computeNetworkPolicyDigest(categories);
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error("sandbox network policy digest is invalid");
  }

  return Object.freeze({
    categories: Object.freeze(categories),
    digest,
    dockerNetworkName,
    proxyContainerName,
    proxyUrl,
  });
}

export function computeNetworkPolicyDigest(
  categories: readonly ResolvedNetworkCategoryPolicy[],
): string {
  const ordered = NETWORK_ENDPOINT_CATEGORIES.map((category) => {
    const matches = categories.filter((entry) => entry.category === category);
    if (matches.length !== 1) {
      throw new Error(`network policy category is missing or ambiguous: ${category}`);
    }
    const entry = matches[0]!;
    return {
      category: entry.category,
      classification: entry.classification,
      endpoints: [...entry.endpoints].sort(),
    };
  });
  const hex = createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
  return `sha256:${hex}`;
}

function parseCategory(
  category: NetworkEndpointCategory,
  raw: unknown,
): ResolvedNetworkCategoryPolicy {
  const record = asObject(raw, `sandbox network policy.${category}`);
  const keys = Object.keys(record);
  if (keys.length !== 2 || !("classification" in record) || !("endpoints" in record)) {
    throw new Error(`sandbox network policy.${category} must contain only classification and endpoints`);
  }
  const classification = record.classification;
  if (typeof classification !== "string" || !isResolvedClassification(classification)) {
    throw new Error(`sandbox network policy.${category}.classification must be required, allowed, or denied`);
  }
  const typedClassification = classification;
  const rawEndpoints = record.endpoints;
  if (!Array.isArray(rawEndpoints)) {
    throw new Error(`sandbox network policy.${category}.endpoints must be an array`);
  }
  const endpoints = rawEndpoints.map((entry, index) =>
    validateEndpoint(entry, `${category}.endpoints[${index}]`),
  );
  if (new Set(endpoints).size !== endpoints.length) {
    throw new Error(`sandbox network policy.${category}.endpoints must not contain duplicates`);
  }
  if (typedClassification === "denied" && endpoints.length !== 0) {
    throw new Error(`denied network category must have an empty endpoint set: ${category}`);
  }
  if (typedClassification !== "denied" && endpoints.length === 0) {
    throw new Error(`required/allowed network category must have a bounded endpoint set: ${category}`);
  }
  return Object.freeze({
    category,
    classification: typedClassification,
    endpoints: Object.freeze(endpoints),
  });
}

function enforceV04CodexPolicy(
  categories: readonly ResolvedNetworkCategoryPolicy[],
): void {
  const byCategory = new Map(categories.map((entry) => [entry.category, entry]));
  if (byCategory.get("agent-provider")?.classification !== "required") {
    throw new Error("Codex CLI mode requires an explicit bounded Agent provider endpoint policy");
  }
  if (byCategory.get("source-repository")?.classification !== "denied") {
    throw new Error("Agent sandbox source-repository network access is denied in v0.4.0");
  }
  if (byCategory.get("other-external-endpoint")?.classification !== "denied") {
    throw new Error("other external endpoint access is denied in v0.4.0");
  }
}

function isResolvedClassification(
  value: string,
): value is ResolvedNetworkClassification {
  return value === "required" || value === "allowed" || value === "denied";
}

function validateEndpoint(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() !== value || value === "") {
    throw new Error(`invalid bounded endpoint at ${path}`);
  }
  if (value.includes("*")) {
    throw new Error(`wildcard endpoint is not permitted at ${path}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid endpoint URL at ${path}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`endpoint must use http or https at ${path}`);
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`endpoint must be a credential-free origin at ${path}`);
  }
  return value;
}

function validateProxyUrl(value: string, expectedHost: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("AGENT_RUNNER_SANDBOX_PROXY_URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("AGENT_RUNNER_SANDBOX_PROXY_URL must use http or https");
  }
  if (parsed.hostname !== expectedHost) {
    throw new Error("AGENT_RUNNER_SANDBOX_PROXY_URL host must match managed proxy container name");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("AGENT_RUNNER_SANDBOX_PROXY_URL must be a credential-free origin");
  }
  return value;
}

function requiredDockerName(value: string | undefined, name: string): string {
  const parsed = requiredNonBlank(value, name);
  if (!DOCKER_NAME_PATTERN.test(parsed)) {
    throw new Error(`${name} must be a valid Docker object name`);
  }
  return parsed;
}

function requiredNonBlank(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function asObject(value: unknown, path: string): NetworkPolicyObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as NetworkPolicyObject;
}
