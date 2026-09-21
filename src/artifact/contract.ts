import { createHash } from "node:crypto";

export const PHASE49_ARTIFACT_FORMAT_VERSION = "phase49.single.v1" as const;
export const PHASE49_PATCH_FORMAT = "git-diff-binary-v1" as const;
export const PHASE49_CHECKSUM_ALGORITHM = "sha256" as const;
export const PHASE49_S3_CHECKSUM_ALGORITHM = "SHA256" as const;
export const PHASE49_S3_CHECKSUM_TYPE = "FULL_OBJECT" as const;
export const PHASE49_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const PHASE49_METADATA_BUDGET_BYTES = 1536;
export const PHASE49_CANONICAL_FAILURE_OUTCOME = "artifact_persistence_failed" as const;
export const PHASE49_PATCH_SECRET_POLICY = "private-s3-encryption-boundary" as const;

export type Phase49ArtifactOutcome = "changes_ready" | "no_changes";

export type Phase49ChangedFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "type_changed"
  | "unmerged"
  | "untracked"
  | "other";

export interface Phase49ChangedFile {
  readonly path: string;
  readonly status: Phase49ChangedFileStatus;
}

export interface Phase49PatchCapture {
  readonly text: string;
  readonly capturedBytes: number;
  readonly truncated: boolean;
}

export interface Phase49ArtifactBuildInput {
  readonly executionId: string;
  readonly issueId: number;
  readonly repository: string;
  readonly sourceRevision: string;
  readonly briefRevision: number;
  readonly persistedRevision: string;
  readonly requirementsFingerprint: string;
  readonly outcome: Phase49ArtifactOutcome;
  readonly changedFiles: readonly Phase49ChangedFile[];
  readonly patch: Phase49PatchCapture;
}

/**
 * Structural view of the Phase 48-7 development handoff. Keeping this adapter
 * structural prevents the Phase 49 contract from making the development module
 * a second contract authority.
 */
export interface Phase49DevelopmentHandoffInput {
  readonly executionId: string;
  readonly issueId: number;
  readonly repository: string;
  readonly sourceRevision: string;
  readonly briefRevision: number;
  readonly persistedRevision: string;
  readonly requirementsFingerprint: string;
  readonly provisionalOutcome: Phase49ArtifactOutcome;
  readonly changedFiles: readonly Phase49ChangedFile[];
  readonly localChangeSet: {
    readonly patch: Phase49PatchCapture;
  };
}

export interface Phase49ArtifactManifest {
  readonly artifactFormatVersion: typeof PHASE49_ARTIFACT_FORMAT_VERSION;
  readonly executionId: string;
  readonly issueId: number;
  readonly repository: string;
  readonly sourceRevision: string;
  readonly briefRevision: number;
  readonly persistedRevision: string;
  readonly requirementsFingerprint: string;
  readonly outcome: Phase49ArtifactOutcome;
  readonly changedFiles: readonly Phase49ChangedFile[];
  readonly patch: {
    readonly format: typeof PHASE49_PATCH_FORMAT;
    readonly checksumAlgorithm: typeof PHASE49_CHECKSUM_ALGORITHM;
    readonly checksumSha256Hex: string;
  };
}

export interface Phase49ArtifactEnvelopeDocument {
  readonly manifest: Phase49ArtifactManifest;
  readonly patch: string;
}

export const PHASE49_REQUIRED_METADATA_KEYS = Object.freeze([
  "artifact-format-version",
  "execution-id",
  "issue-id",
  "repository",
  "source-revision",
  "brief-revision",
  "persisted-revision",
  "requirements-fingerprint",
  "outcome",
  "patch-checksum",
] as const);

export type Phase49RequiredMetadataKey = (typeof PHASE49_REQUIRED_METADATA_KEYS)[number];
export type Phase49ArtifactMetadata = Readonly<Record<Phase49RequiredMetadataKey, string>>;

export interface Phase49BuiltArtifact {
  readonly manifest: Phase49ArtifactManifest;
  readonly body: Uint8Array;
  readonly bodyUtf8: string;
  readonly sizeBytes: number;
  readonly metadata: Phase49ArtifactMetadata;
  readonly metadataBytes: number;
  readonly patchChecksumSha256Hex: string;
  readonly envelopeChecksumSha256Hex: string;
  readonly envelopeChecksumSha256Base64: string;
  readonly checksumAlgorithm: typeof PHASE49_S3_CHECKSUM_ALGORITHM;
  readonly checksumType: typeof PHASE49_S3_CHECKSUM_TYPE;
}

export interface Phase49HeadObservation {
  /** The caller must explicitly request checksum retrieval (AWS: ChecksumMode=ENABLED). */
  readonly checksumModeEnabled: boolean;
  readonly checksumType?: string | null;
  readonly checksumSha256Base64?: string | null;
  readonly metadata?: Readonly<Record<string, string | undefined>> | null;
}

export type Phase49ArtifactFailureReason =
  | "storage_failure"
  | "integrity_failure"
  | "artifact_too_large"
  | "secret_policy_rejection"
  | "result_validation_failure";

export function canonicalArtifactFailureOutcome(
  _reason: Phase49ArtifactFailureReason,
): typeof PHASE49_CANONICAL_FAILURE_OUTCOME {
  // v0.4.0 decision: keep the Phase 45 durable taxonomy unchanged. Detailed
  // artifact-pipeline causes remain diagnostics/reason codes rather than new
  // Redmine outcome values.
  return PHASE49_CANONICAL_FAILURE_OUTCOME;
}

export function buildPhase49ArtifactFromDevelopmentHandoff(
  handoff: Phase49DevelopmentHandoffInput,
): Phase49BuiltArtifact {
  return buildPhase49Artifact({
    executionId: handoff.executionId,
    issueId: handoff.issueId,
    repository: handoff.repository,
    sourceRevision: handoff.sourceRevision,
    briefRevision: handoff.briefRevision,
    persistedRevision: handoff.persistedRevision,
    requirementsFingerprint: handoff.requirementsFingerprint,
    outcome: handoff.provisionalOutcome,
    changedFiles: handoff.changedFiles,
    patch: handoff.localChangeSet.patch,
  });
}

export function buildPhase49Artifact(input: Phase49ArtifactBuildInput): Phase49BuiltArtifact {
  assertBuildInput(input);

  const changedFiles = normalizeChangedFiles(input.changedFiles);
  assertOutcomeMatchesChangeSet(input.outcome, changedFiles, input.patch.text);

  const patchBytes = Buffer.from(input.patch.text, "utf8");
  const patchChecksumSha256Hex = sha256Hex(patchBytes);

  const manifest: Phase49ArtifactManifest = Object.freeze({
    artifactFormatVersion: PHASE49_ARTIFACT_FORMAT_VERSION,
    executionId: input.executionId,
    issueId: input.issueId,
    repository: input.repository,
    sourceRevision: input.sourceRevision,
    briefRevision: input.briefRevision,
    persistedRevision: input.persistedRevision,
    requirementsFingerprint: input.requirementsFingerprint,
    outcome: input.outcome,
    changedFiles,
    patch: Object.freeze({
      format: PHASE49_PATCH_FORMAT,
      checksumAlgorithm: PHASE49_CHECKSUM_ALGORITHM,
      checksumSha256Hex: patchChecksumSha256Hex,
    }),
  });

  const document: CanonicalJsonObject = {
    manifest: manifestToCanonicalJson(manifest),
    patch: input.patch.text,
  };
  const bodyUtf8 = canonicalJsonStringify(document);
  const body = Buffer.from(bodyUtf8, "utf8");

  if (body.byteLength > PHASE49_MAX_ARTIFACT_BYTES) {
    throw new Error(
      `Phase 49 artifact exceeded maximum size: ${body.byteLength} > ${PHASE49_MAX_ARTIFACT_BYTES}`,
    );
  }

  const envelopeChecksumSha256Hex = sha256Hex(body);
  const envelopeChecksumSha256Base64 = sha256Base64(body);
  const metadata = buildPhase49Metadata(manifest);
  const metadataBytes = measureMetadataBytes(metadata);

  if (metadataBytes > PHASE49_METADATA_BUDGET_BYTES) {
    throw new Error(
      `Phase 49 S3 metadata exceeded budget: ${metadataBytes} > ${PHASE49_METADATA_BUDGET_BYTES}`,
    );
  }

  return Object.freeze({
    manifest,
    body,
    bodyUtf8,
    sizeBytes: body.byteLength,
    metadata,
    metadataBytes,
    patchChecksumSha256Hex,
    envelopeChecksumSha256Hex,
    envelopeChecksumSha256Base64,
    checksumAlgorithm: PHASE49_S3_CHECKSUM_ALGORITHM,
    checksumType: PHASE49_S3_CHECKSUM_TYPE,
  });
}

export function verifyPhase49ArtifactHead(
  expected: Phase49BuiltArtifact,
  observed: Phase49HeadObservation,
): void {
  if (!observed.checksumModeEnabled) {
    throw new Error("Phase 49 artifact verification requires ChecksumMode=ENABLED");
  }
  if (observed.checksumType !== PHASE49_S3_CHECKSUM_TYPE) {
    throw new Error("Phase 49 artifact checksum type is missing or is not FULL_OBJECT");
  }
  if (!isPresent(observed.checksumSha256Base64)) {
    throw new Error("Phase 49 artifact ChecksumSHA256 is missing");
  }
  if (observed.checksumSha256Base64 !== expected.envelopeChecksumSha256Base64) {
    throw new Error("Phase 49 artifact envelope checksum mismatch");
  }

  const metadata = observed.metadata;
  if (metadata === null || metadata === undefined) {
    throw new Error("Phase 49 artifact metadata projection is missing");
  }

  const observedKeys = Object.keys(metadata).sort();
  const expectedKeys = [...PHASE49_REQUIRED_METADATA_KEYS].sort();
  if (observedKeys.length !== expectedKeys.length) {
    throw new Error("Phase 49 artifact metadata field set mismatch");
  }
  for (let index = 0; index < expectedKeys.length; index += 1) {
    if (observedKeys[index] !== expectedKeys[index]) {
      throw new Error("Phase 49 artifact metadata field set mismatch");
    }
  }

  for (const key of PHASE49_REQUIRED_METADATA_KEYS) {
    const value = metadata[key];
    if (!isPresent(value)) {
      throw new Error(`Phase 49 artifact required metadata is missing: ${key}`);
    }
    if (!isAscii(value)) {
      throw new Error(`Phase 49 artifact metadata is not ASCII-safe: ${key}`);
    }
    if (value !== expected.metadata[key]) {
      throw new Error(`Phase 49 artifact metadata mismatch: ${key}`);
    }
  }
}

export function verifyPhase49ArtifactBody(
  body: Uint8Array,
  expected?: Phase49BuiltArtifact,
): Phase49ArtifactEnvelopeDocument {
  const text = Buffer.from(body).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Phase 49 artifact body is not valid JSON");
  }

  const document = parseArtifactDocument(parsed);
  const canonical = canonicalJsonStringify({
    manifest: manifestToCanonicalJson(document.manifest),
    patch: document.patch,
  });
  if (canonical !== text) {
    throw new Error("Phase 49 artifact body is not in canonical serialization form");
  }

  const patchBytes = Buffer.from(document.patch, "utf8");
  if (sha256Hex(patchBytes) !== document.manifest.patch.checksumSha256Hex) {
    throw new Error("Phase 49 artifact patch checksum mismatch");
  }

  if (expected !== undefined) {
    if (sha256Hex(body) !== expected.envelopeChecksumSha256Hex) {
      throw new Error("Phase 49 artifact body envelope checksum mismatch");
    }
    assertManifestIdentityMatches(expected.manifest, document.manifest);
  }

  return document;
}

function assertBuildInput(input: Phase49ArtifactBuildInput): void {
  assertNonEmpty(input.executionId, "executionId");
  assertPositiveSafeInteger(input.issueId, "issueId");
  assertNonEmpty(input.repository, "repository");
  assertNonEmpty(input.sourceRevision, "sourceRevision");
  assertPositiveSafeInteger(input.briefRevision, "briefRevision");
  assertNonEmpty(input.persistedRevision, "persistedRevision");
  assertNonEmpty(input.requirementsFingerprint, "requirementsFingerprint");

  if (input.patch.truncated) {
    throw new Error("Phase 49 artifact cannot persist a truncated patch");
  }
  const patchBytes = Buffer.byteLength(input.patch.text, "utf8");
  if (input.patch.capturedBytes !== patchBytes) {
    throw new Error("Phase 49 patch byte count does not match serialized patch bytes");
  }
}

function assertOutcomeMatchesChangeSet(
  outcome: Phase49ArtifactOutcome,
  changedFiles: readonly Phase49ChangedFile[],
  patch: string,
): void {
  const hasChanges = changedFiles.length > 0;
  const hasPatch = Buffer.byteLength(patch, "utf8") > 0;

  if (outcome === "changes_ready" && (!hasChanges || !hasPatch)) {
    throw new Error("changes_ready requires a non-empty changed-file set and patch");
  }
  if (outcome === "no_changes" && (hasChanges || hasPatch)) {
    throw new Error("no_changes requires an empty changed-file set and canonical empty patch");
  }
}

function normalizeChangedFiles(
  changedFiles: readonly Phase49ChangedFile[],
): readonly Phase49ChangedFile[] {
  const normalized = changedFiles.map((entry) => {
    assertNonEmpty(entry.path, "changed file path");
    if (entry.path.includes("\0")) {
      throw new Error("Phase 49 changed-file path contains NUL");
    }
    return Object.freeze({ path: entry.path, status: entry.status });
  }).sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]?.path === normalized[index]?.path) {
      throw new Error(`Phase 49 changed-file identity is duplicated: ${normalized[index]?.path ?? ""}`);
    }
  }
  return Object.freeze(normalized);
}

function buildPhase49Metadata(manifest: Phase49ArtifactManifest): Phase49ArtifactMetadata {
  const metadata: Record<Phase49RequiredMetadataKey, string> = {
    "artifact-format-version": manifest.artifactFormatVersion,
    "execution-id": manifest.executionId,
    "issue-id": String(manifest.issueId),
    repository: asciiProjection(manifest.repository),
    "source-revision": asciiProjection(manifest.sourceRevision),
    "brief-revision": String(manifest.briefRevision),
    "persisted-revision": asciiProjection(manifest.persistedRevision),
    "requirements-fingerprint": asciiProjection(manifest.requirementsFingerprint),
    outcome: manifest.outcome,
    "patch-checksum": manifest.patch.checksumSha256Hex,
  };

  for (const key of PHASE49_REQUIRED_METADATA_KEYS) {
    if (key !== key.toLowerCase() || key.includes("_")) {
      throw new Error(`Phase 49 metadata key violates lowercase kebab-case contract: ${key}`);
    }
    const value = metadata[key];
    if (!isPresent(value) || !isAscii(value)) {
      throw new Error(`Phase 49 metadata value is invalid: ${key}`);
    }
  }

  return Object.freeze(metadata);
}

function measureMetadataBytes(metadata: Phase49ArtifactMetadata): number {
  let bytes = 0;
  for (const key of PHASE49_REQUIRED_METADATA_KEYS) {
    const fullHeaderName = `x-amz-meta-${key}`;
    bytes += Buffer.byteLength(fullHeaderName, "ascii");
    bytes += Buffer.byteLength(metadata[key], "ascii");
  }
  return bytes;
}

function asciiProjection(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Base64(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("base64");
}

function assertManifestIdentityMatches(
  expected: Phase49ArtifactManifest,
  actual: Phase49ArtifactManifest,
): void {
  if (
    expected.artifactFormatVersion !== actual.artifactFormatVersion ||
    expected.executionId !== actual.executionId ||
    expected.issueId !== actual.issueId ||
    expected.repository !== actual.repository ||
    expected.sourceRevision !== actual.sourceRevision ||
    expected.briefRevision !== actual.briefRevision ||
    expected.persistedRevision !== actual.persistedRevision ||
    expected.requirementsFingerprint !== actual.requirementsFingerprint ||
    expected.outcome !== actual.outcome ||
    expected.patch.checksumSha256Hex !== actual.patch.checksumSha256Hex
  ) {
    throw new Error("Phase 49 artifact manifest identity mismatch");
  }
}

type CanonicalJsonPrimitive = string | number | boolean | null;
type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | CanonicalJsonObject;
interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}

function manifestToCanonicalJson(manifest: Phase49ArtifactManifest): CanonicalJsonObject {
  return {
    artifactFormatVersion: manifest.artifactFormatVersion,
    briefRevision: manifest.briefRevision,
    changedFiles: manifest.changedFiles.map((entry) => ({ path: entry.path, status: entry.status })),
    executionId: manifest.executionId,
    issueId: manifest.issueId,
    outcome: manifest.outcome,
    patch: {
      checksumAlgorithm: manifest.patch.checksumAlgorithm,
      checksumSha256Hex: manifest.patch.checksumSha256Hex,
      format: manifest.patch.format,
    },
    persistedRevision: manifest.persistedRevision,
    repository: manifest.repository,
    requirementsFingerprint: manifest.requirementsFingerprint,
    sourceRevision: manifest.sourceRevision,
  };
}

function canonicalJsonStringify(value: CanonicalJsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Phase 49 canonical JSON rejects non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const arrayValue = value as readonly CanonicalJsonValue[];
    return `[${arrayValue.map((entry) => canonicalJsonStringify(entry)).join(",")}]`;
  }

  const objectValue = value as CanonicalJsonObject;
  const entries = Object.keys(objectValue).sort().map((key) => {
    const entry = objectValue[key];
    if (entry === undefined) {
      throw new Error("Phase 49 canonical JSON rejects undefined values");
    }
    return `${JSON.stringify(key)}:${canonicalJsonStringify(entry)}`;
  });
  return `{${entries.join(",")}}`;
}

function parseArtifactDocument(value: unknown): Phase49ArtifactEnvelopeDocument {
  const root = requireRecord(value, "artifact document");
  assertExactKeys(root, ["manifest", "patch"], "artifact document");
  const manifest = parseManifest(root.manifest);
  const patch = requireAnyString(root.patch, "artifact patch");
  return Object.freeze({ manifest, patch });
}

function parseManifest(value: unknown): Phase49ArtifactManifest {
  const manifest = requireRecord(value, "artifact manifest");
  assertExactKeys(manifest, [
    "artifactFormatVersion",
    "briefRevision",
    "changedFiles",
    "executionId",
    "issueId",
    "outcome",
    "patch",
    "persistedRevision",
    "repository",
    "requirementsFingerprint",
    "sourceRevision",
  ], "artifact manifest");

  const artifactFormatVersion = requireString(manifest.artifactFormatVersion, "artifactFormatVersion");
  if (artifactFormatVersion !== PHASE49_ARTIFACT_FORMAT_VERSION) {
    throw new Error("Phase 49 artifact format version is unsupported");
  }

  const outcome = requireString(manifest.outcome, "outcome");
  if (outcome !== "changes_ready" && outcome !== "no_changes") {
    throw new Error("Phase 49 artifact outcome is unsupported");
  }

  const patchObject = requireRecord(manifest.patch, "manifest patch");
  assertExactKeys(patchObject, ["checksumAlgorithm", "checksumSha256Hex", "format"], "manifest patch");
  const format = requireString(patchObject.format, "patch format");
  const checksumAlgorithm = requireString(patchObject.checksumAlgorithm, "patch checksum algorithm");
  const checksumSha256Hex = requireString(patchObject.checksumSha256Hex, "patch checksum");
  if (format !== PHASE49_PATCH_FORMAT || checksumAlgorithm !== PHASE49_CHECKSUM_ALGORITHM) {
    throw new Error("Phase 49 patch contract is unsupported");
  }
  if (!/^[0-9a-f]{64}$/u.test(checksumSha256Hex)) {
    throw new Error("Phase 49 patch checksum representation is invalid");
  }

  const changedFilesValue = manifest.changedFiles;
  if (!Array.isArray(changedFilesValue)) {
    throw new Error("Phase 49 artifact changedFiles must be an array");
  }
  const changedFiles = changedFilesValue.map((entry) => parseChangedFile(entry));

  const parsed: Phase49ArtifactManifest = Object.freeze({
    artifactFormatVersion: PHASE49_ARTIFACT_FORMAT_VERSION,
    executionId: requireString(manifest.executionId, "executionId"),
    issueId: requirePositiveSafeInteger(manifest.issueId, "issueId"),
    repository: requireString(manifest.repository, "repository"),
    sourceRevision: requireString(manifest.sourceRevision, "sourceRevision"),
    briefRevision: requirePositiveSafeInteger(manifest.briefRevision, "briefRevision"),
    persistedRevision: requireString(manifest.persistedRevision, "persistedRevision"),
    requirementsFingerprint: requireString(manifest.requirementsFingerprint, "requirementsFingerprint"),
    outcome,
    changedFiles: Object.freeze(changedFiles),
    patch: Object.freeze({
      format: PHASE49_PATCH_FORMAT,
      checksumAlgorithm: PHASE49_CHECKSUM_ALGORITHM,
      checksumSha256Hex,
    }),
  });

  const normalized = normalizeChangedFiles(parsed.changedFiles);
  if (canonicalJsonStringify(normalized.map((entry) => ({ path: entry.path, status: entry.status }))) !==
      canonicalJsonStringify(parsed.changedFiles.map((entry) => ({ path: entry.path, status: entry.status })))) {
    throw new Error("Phase 49 artifact changedFiles are not in canonical order");
  }

  return parsed;
}

function parseChangedFile(value: unknown): Phase49ChangedFile {
  const entry = requireRecord(value, "changed file");
  assertExactKeys(entry, ["path", "status"], "changed file");
  const path = requireString(entry.path, "changed file path");
  const status = requireString(entry.status, "changed file status");
  if (!isChangedFileStatus(status)) {
    throw new Error("Phase 49 changed-file status is unsupported");
  }
  return Object.freeze({ path, status });
}

function isChangedFileStatus(value: string): value is Phase49ChangedFileStatus {
  return value === "added" ||
    value === "modified" ||
    value === "deleted" ||
    value === "type_changed" ||
    value === "unmerged" ||
    value === "untracked" ||
    value === "other";
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Phase 49 ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length) {
    throw new Error(`Phase 49 ${label} field set mismatch`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(`Phase 49 ${label} field set mismatch`);
    }
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Phase 49 ${label} must be a non-empty string`);
  }
  return value;
}

function requireAnyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Phase 49 ${label} must be a string`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Phase 49 ${label} must be a positive safe integer`);
  }
  return value;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`Phase 49 ${label} must not be empty`);
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Phase 49 ${label} must be a positive safe integer`);
  }
}

function isPresent(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7e]+$/u.test(value);
}
