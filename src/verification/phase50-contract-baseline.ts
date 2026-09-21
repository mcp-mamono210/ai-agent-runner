import {
  PHASE49_ARTIFACT_FORMAT_VERSION,
  PHASE49_CANONICAL_FAILURE_OUTCOME,
  PHASE49_CHECKSUM_ALGORITHM,
  PHASE49_MAX_ARTIFACT_BYTES,
  PHASE49_PATCH_FORMAT,
  PHASE49_REQUIRED_METADATA_KEYS,
  PHASE49_S3_CHECKSUM_ALGORITHM,
  PHASE49_S3_CHECKSUM_TYPE,
  buildPhase49Artifact,
} from "../artifact/contract.js";
import {
  PHASE49_S3_SERVER_SIDE_ENCRYPTION,
  phase49ArtifactObjectKey,
} from "../artifact/s3-persistence.js";
import {
  PROVISIONAL_EXECUTION_OUTCOMES,
  STARTED_EXECUTION_FAILURE_OUTCOMES,
  STARTED_FAILURE_RECONCILIATION_FALLBACK,
} from "../agent/types.js";
import {
  PRE_EXECUTION_REJECTION_OUTCOMES,
  READY_FOR_AGENT_LIFECYCLE,
} from "../controller/types.js";
import {
  PHASE49_AGENT_RUNNING,
  PHASE49_NEEDS_HUMAN,
  PHASE49_READY_FOR_INDEPENDENT_VERIFICATION,
} from "../redmine/phase49-finalizer.js";

export const PHASE50_GOLDEN_CONTRACT_SCHEMA_VERSION = 1 as const;
export const PHASE50_EXPECTED_FAILURE_REGISTRY_SCHEMA_VERSION = 1 as const;

export const PHASE50_CONTROLLER_REQUIRED_S3_ACTIONS = Object.freeze([
  "s3:PutObject",
  "s3:GetObject",
] as const);

export const PHASE50_CONTROLLER_NOT_REQUIRED_S3_ACTIONS = Object.freeze([
  "s3:DeleteObject",
  "s3:ListBucket",
] as const);

export interface Phase50ArtifactGoldenContract {
  readonly formatVersion: string;
  readonly singleObject: true;
  readonly envelopeRequiredKeys: readonly string[];
  readonly manifestRequiredKeys: readonly string[];
  readonly metadataRequiredKeys: readonly string[];
  readonly metadataKeyRule: "lowercase-kebab-case";
  readonly patchFormat: string;
  readonly patchChecksumAlgorithm: string;
  readonly s3ChecksumAlgorithm: string;
  readonly s3ChecksumType: string;
  readonly maximumArtifactSizeBytes: number;
  readonly uploadMode: "direct PutObject";
  readonly conditionalWrite: "If-None-Match:*";
  readonly deterministicObjectKey: "{prefix}/{execution_id}.json";
  readonly serverSideEncryption: string;
}

export interface Phase50IamGoldenContract {
  readonly requiredControllerActions: readonly string[];
  readonly notRequiredControllerActions: readonly string[];
}

export interface Phase50GoldenContract {
  readonly schemaVersion: typeof PHASE50_GOLDEN_CONTRACT_SCHEMA_VERSION;
  readonly canonicalSources: readonly {
    readonly repository: string;
    readonly revision: string;
    readonly path: string;
  }[];
  readonly executionLifecycles: readonly string[];
  readonly executionOutcomes: readonly string[];
  readonly artifact: Phase50ArtifactGoldenContract;
  readonly iam: Phase50IamGoldenContract;
}

export interface Phase50ExpectedFailureEntry {
  readonly testIdentity: string;
  readonly blockingDefectIssueId: number;
  readonly expectedFailureReason: string;
  readonly canonicalContractReference: string;
  readonly detectedDate: string;
}

export interface Phase50ExpectedFailureRegistry {
  readonly schemaVersion: typeof PHASE50_EXPECTED_FAILURE_REGISTRY_SCHEMA_VERSION;
  readonly entries: readonly Phase50ExpectedFailureEntry[];
}

export type Phase50ExpectedFailureObservation =
  | { readonly kind: "expected_failure"; readonly observedReason: string }
  | { readonly kind: "unexpected_pass" }
  | { readonly kind: "unrelated_failure"; readonly observedReason: string };

export function projectPhase50CurrentImplementation(): Omit<
  Phase50GoldenContract,
  "canonicalSources"
> {
  const sample = buildPhase49Artifact({
    executionId: "123e4567-e89b-42d3-a456-426614174000",
    issueId: 5425,
    repository: "mcp-mamono210/ai-agent-runner",
    sourceRevision: "a".repeat(40),
    briefRevision: 1,
    persistedRevision: "phase50-baseline",
    requirementsFingerprint: `sha256:${"b".repeat(64)}`,
    outcome: "changes_ready",
    changedFiles: [{ path: "src/example.ts", status: "modified" }],
    patch: {
      text: "diff --git a/src/example.ts b/src/example.ts\n",
      capturedBytes: Buffer.byteLength(
        "diff --git a/src/example.ts b/src/example.ts\n",
        "utf8",
      ),
      truncated: false,
    },
  });

  const parsedBody = parseJsonRecord(sample.bodyUtf8, "Phase 49 artifact envelope");

  return Object.freeze({
    schemaVersion: PHASE50_GOLDEN_CONTRACT_SCHEMA_VERSION,
    executionLifecycles: Object.freeze([
      READY_FOR_AGENT_LIFECYCLE,
      PHASE49_AGENT_RUNNING,
      PHASE49_READY_FOR_INDEPENDENT_VERIFICATION,
      PHASE49_NEEDS_HUMAN,
    ]),
    executionOutcomes: Object.freeze([
      ...PROVISIONAL_EXECUTION_OUTCOMES,
      ...PRE_EXECUTION_REJECTION_OUTCOMES,
      STARTED_FAILURE_RECONCILIATION_FALLBACK,
      ...STARTED_EXECUTION_FAILURE_OUTCOMES,
      PHASE49_CANONICAL_FAILURE_OUTCOME,
    ]),
    artifact: Object.freeze({
      formatVersion: PHASE49_ARTIFACT_FORMAT_VERSION,
      singleObject: true,
      envelopeRequiredKeys: Object.freeze(Object.keys(parsedBody).sort()),
      manifestRequiredKeys: Object.freeze(Object.keys(sample.manifest).sort()),
      metadataRequiredKeys: PHASE49_REQUIRED_METADATA_KEYS,
      metadataKeyRule: "lowercase-kebab-case",
      patchFormat: PHASE49_PATCH_FORMAT,
      patchChecksumAlgorithm: PHASE49_CHECKSUM_ALGORITHM,
      s3ChecksumAlgorithm: PHASE49_S3_CHECKSUM_ALGORITHM,
      s3ChecksumType: PHASE49_S3_CHECKSUM_TYPE,
      maximumArtifactSizeBytes: PHASE49_MAX_ARTIFACT_BYTES,
      uploadMode: "direct PutObject",
      conditionalWrite: "If-None-Match:*",
      deterministicObjectKey: "{prefix}/{execution_id}.json",
      serverSideEncryption: PHASE49_S3_SERVER_SIDE_ENCRYPTION,
    }),
    iam: Object.freeze({
      requiredControllerActions: PHASE50_CONTROLLER_REQUIRED_S3_ACTIONS,
      notRequiredControllerActions: PHASE50_CONTROLLER_NOT_REQUIRED_S3_ACTIONS,
    }),
  });
}

export function assertPhase50GoldenContractMatches(
  golden: Phase50GoldenContract,
  actual: Omit<Phase50GoldenContract, "canonicalSources"> =
    projectPhase50CurrentImplementation(),
): void {
  assertSameArray(
    golden.executionLifecycles,
    actual.executionLifecycles,
    "execution lifecycles",
  );
  assertSameArray(golden.executionOutcomes, actual.executionOutcomes, "execution outcomes");
  assertSameValue(golden.artifact.formatVersion, actual.artifact.formatVersion, "artifact format version");
  assertSameValue(golden.artifact.singleObject, actual.artifact.singleObject, "single-object composition");
  assertSameArray(
    golden.artifact.envelopeRequiredKeys,
    actual.artifact.envelopeRequiredKeys,
    "artifact envelope fields",
  );
  assertSameArray(
    golden.artifact.manifestRequiredKeys,
    actual.artifact.manifestRequiredKeys,
    "artifact manifest fields",
  );
  assertSameArray(
    golden.artifact.metadataRequiredKeys,
    actual.artifact.metadataRequiredKeys,
    "artifact metadata fields",
  );
  assertSameValue(golden.artifact.metadataKeyRule, actual.artifact.metadataKeyRule, "metadata key rule");
  assertSameValue(golden.artifact.patchFormat, actual.artifact.patchFormat, "patch format");
  assertSameValue(
    golden.artifact.patchChecksumAlgorithm,
    actual.artifact.patchChecksumAlgorithm,
    "patch checksum algorithm",
  );
  assertSameValue(
    golden.artifact.s3ChecksumAlgorithm,
    actual.artifact.s3ChecksumAlgorithm,
    "S3 checksum algorithm",
  );
  assertSameValue(golden.artifact.s3ChecksumType, actual.artifact.s3ChecksumType, "S3 checksum type");
  assertSameValue(
    golden.artifact.maximumArtifactSizeBytes,
    actual.artifact.maximumArtifactSizeBytes,
    "maximum artifact size",
  );
  assertSameValue(golden.artifact.uploadMode, actual.artifact.uploadMode, "artifact upload mode");
  assertSameValue(
    golden.artifact.conditionalWrite,
    actual.artifact.conditionalWrite,
    "conditional write contract",
  );
  assertSameValue(
    golden.artifact.deterministicObjectKey,
    actual.artifact.deterministicObjectKey,
    "deterministic object key",
  );
  assertSameValue(
    golden.artifact.serverSideEncryption,
    actual.artifact.serverSideEncryption,
    "server-side encryption",
  );
  assertSameArray(
    golden.iam.requiredControllerActions,
    actual.iam.requiredControllerActions,
    "Controller required IAM actions",
  );
  assertSameArray(
    golden.iam.notRequiredControllerActions,
    actual.iam.notRequiredControllerActions,
    "Controller not-required IAM actions",
  );
}

export function assertExpectedFailureObservation(
  entry: Phase50ExpectedFailureEntry,
  observation: Phase50ExpectedFailureObservation,
): void {
  switch (observation.kind) {
    case "expected_failure":
      if (observation.observedReason !== entry.expectedFailureReason) {
        throw new Error(
          `Phase 50 expected-failure marker hid unrelated failure for ${entry.testIdentity}`,
        );
      }
      return;
    case "unexpected_pass":
      throw new Error(`Phase 50 XPASS requires marker removal: ${entry.testIdentity}`);
    case "unrelated_failure":
      throw new Error(
        `Phase 50 expected-failure marker observed unrelated failure for ${entry.testIdentity}: ${observation.observedReason}`,
      );
  }
}

export function parsePhase50GoldenContract(value: unknown): Phase50GoldenContract {
  const root = requireRecord(value, "Phase 50 golden contract");
  const schemaVersion = requireInteger(root.schemaVersion, "schemaVersion");
  if (schemaVersion !== PHASE50_GOLDEN_CONTRACT_SCHEMA_VERSION) {
    throw new Error("Phase 50 golden contract schema version is unsupported");
  }

  const artifact = requireRecord(root.artifact, "artifact");
  const iam = requireRecord(root.iam, "iam");

  return Object.freeze({
    schemaVersion,
    canonicalSources: Object.freeze(
      requireArray(root.canonicalSources, "canonicalSources").map((entry, index) => {
        const source = requireRecord(entry, `canonicalSources[${index}]`);
        return Object.freeze({
          repository: requireString(source.repository, `canonicalSources[${index}].repository`),
          revision: requireString(source.revision, `canonicalSources[${index}].revision`),
          path: requireString(source.path, `canonicalSources[${index}].path`),
        });
      }),
    ),
    executionLifecycles: Object.freeze(
      requireStringArray(root.executionLifecycles, "executionLifecycles"),
    ),
    executionOutcomes: Object.freeze(requireStringArray(root.executionOutcomes, "executionOutcomes")),
    artifact: Object.freeze({
      formatVersion: requireString(artifact.formatVersion, "artifact.formatVersion"),
      singleObject: requireTrue(artifact.singleObject, "artifact.singleObject"),
      envelopeRequiredKeys: Object.freeze(
        requireStringArray(artifact.envelopeRequiredKeys, "artifact.envelopeRequiredKeys"),
      ),
      manifestRequiredKeys: Object.freeze(
        requireStringArray(artifact.manifestRequiredKeys, "artifact.manifestRequiredKeys"),
      ),
      metadataRequiredKeys: Object.freeze(
        requireStringArray(artifact.metadataRequiredKeys, "artifact.metadataRequiredKeys"),
      ),
      metadataKeyRule: requireLiteral(
        artifact.metadataKeyRule,
        "lowercase-kebab-case",
        "artifact.metadataKeyRule",
      ),
      patchFormat: requireString(artifact.patchFormat, "artifact.patchFormat"),
      patchChecksumAlgorithm: requireString(
        artifact.patchChecksumAlgorithm,
        "artifact.patchChecksumAlgorithm",
      ),
      s3ChecksumAlgorithm: requireString(
        artifact.s3ChecksumAlgorithm,
        "artifact.s3ChecksumAlgorithm",
      ),
      s3ChecksumType: requireString(artifact.s3ChecksumType, "artifact.s3ChecksumType"),
      maximumArtifactSizeBytes: requireInteger(
        artifact.maximumArtifactSizeBytes,
        "artifact.maximumArtifactSizeBytes",
      ),
      uploadMode: requireLiteral(artifact.uploadMode, "direct PutObject", "artifact.uploadMode"),
      conditionalWrite: requireLiteral(
        artifact.conditionalWrite,
        "If-None-Match:*",
        "artifact.conditionalWrite",
      ),
      deterministicObjectKey: requireLiteral(
        artifact.deterministicObjectKey,
        "{prefix}/{execution_id}.json",
        "artifact.deterministicObjectKey",
      ),
      serverSideEncryption: requireString(
        artifact.serverSideEncryption,
        "artifact.serverSideEncryption",
      ),
    }),
    iam: Object.freeze({
      requiredControllerActions: Object.freeze(
        requireStringArray(iam.requiredControllerActions, "iam.requiredControllerActions"),
      ),
      notRequiredControllerActions: Object.freeze(
        requireStringArray(iam.notRequiredControllerActions, "iam.notRequiredControllerActions"),
      ),
    }),
  });
}

export function parsePhase50ExpectedFailureRegistry(
  value: unknown,
): Phase50ExpectedFailureRegistry {
  const root = requireRecord(value, "Phase 50 expected-failure registry");
  const schemaVersion = requireInteger(root.schemaVersion, "schemaVersion");
  if (schemaVersion !== PHASE50_EXPECTED_FAILURE_REGISTRY_SCHEMA_VERSION) {
    throw new Error("Phase 50 expected-failure registry schema version is unsupported");
  }

  const entries = requireArray(root.entries, "entries").map((entry, index) => {
    const item = requireRecord(entry, `entries[${index}]`);
    const issueId = requireInteger(item.blockingDefectIssueId, `entries[${index}].blockingDefectIssueId`);
    if (issueId <= 0) {
      throw new Error(`entries[${index}].blockingDefectIssueId must be positive`);
    }
    const detectedDate = requireString(item.detectedDate, `entries[${index}].detectedDate`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(detectedDate)) {
      throw new Error(`entries[${index}].detectedDate must use YYYY-MM-DD`);
    }
    return Object.freeze({
      testIdentity: requireString(item.testIdentity, `entries[${index}].testIdentity`),
      blockingDefectIssueId: issueId,
      expectedFailureReason: requireString(
        item.expectedFailureReason,
        `entries[${index}].expectedFailureReason`,
      ),
      canonicalContractReference: requireString(
        item.canonicalContractReference,
        `entries[${index}].canonicalContractReference`,
      ),
      detectedDate,
    });
  });

  return Object.freeze({ schemaVersion, entries: Object.freeze(entries) });
}

export function assertNoExpectedFailureMarkers(
  registry: Phase50ExpectedFailureRegistry,
): void {
  if (registry.entries.length !== 0) {
    const ids = registry.entries.map((entry) => `#${entry.blockingDefectIssueId}`).join(", ");
    throw new Error(`Phase 50 expected-failure markers remain open: ${ids}`);
  }
}

export function phase50ExampleDeterministicKey(prefix: string, executionId: string): string {
  return phase49ArtifactObjectKey(
    Object.freeze({ region: "ap-northeast-1", bucket: "phase50-example", prefix }),
    executionId,
  );
}

function parseJsonRecord(text: string, label: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return requireRecord(value, label);
}

function assertSameArray(
  expected: readonly string[],
  actual: readonly string[],
  label: string,
): void {
  if (expected.length !== actual.length) {
    throw new Error(`Phase 50 golden contract drift: ${label}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) {
      throw new Error(`Phase 50 golden contract drift: ${label}`);
    }
  }
}

function assertSameValue(
  expected: string | number | boolean,
  actual: string | number | boolean,
  label: string,
): void {
  if (expected !== actual) {
    throw new Error(`Phase 50 golden contract drift: ${label}`);
  }
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  return requireArray(value, label).map((entry, index) =>
    requireString(entry, `${label}[${index}]`),
  );
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return value;
}

function requireTrue(value: unknown, label: string): true {
  if (value !== true) {
    throw new Error(`${label} must be true`);
  }
  return true;
}

function requireLiteral<const T extends string>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) {
    throw new Error(`${label} must equal ${expected}`);
  }
  return expected;
}
