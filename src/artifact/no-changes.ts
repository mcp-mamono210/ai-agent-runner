import {
  buildPhase49ArtifactFromDevelopmentHandoff,
  canonicalArtifactFailureOutcome,
  verifyPhase49ArtifactBody,
  type Phase49ArtifactEnvelopeDocument,
  type Phase49ArtifactManifest,
  type Phase49BuiltArtifact,
  type Phase49DevelopmentHandoffInput,
} from "./contract.js";
import {
  parsePhase49ArtifactReference,
  type Phase49PersistedArtifact,
} from "./s3-persistence.js";

/**
 * The canonical serialized patch representation for a validated no_changes result.
 * An empty artifact is still a non-empty single-object artifact envelope; only its
 * embedded patch payload is the empty UTF-8 byte sequence.
 */
export const PHASE49_CANONICAL_EMPTY_PATCH = "" as const;
export const PHASE49_CANONICAL_EMPTY_PATCH_SHA256_HEX =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as const;

/**
 * Phase 49-1 deliberately keeps result-validation detail out of the durable
 * Redmine outcome taxonomy. no_changes validation failures therefore map to the
 * already-approved artifact_persistence_failed outcome.
 */
export const PHASE49_NO_CHANGES_VALIDATION_FAILURE_OUTCOME =
  canonicalArtifactFailureOutcome("result_validation_failure");

export interface Phase49NoChangesVerificationHandoff {
  readonly executionId: string;
  readonly issueId: number;
  readonly repository: string;
  readonly sourceRevision: string;
  readonly briefRevision: number;
  readonly persistedRevision: string;
  readonly requirementsFingerprint: string;
  readonly outcome: "no_changes";
  readonly artifactReference: string;
  readonly canonicalManifest: Phase49ArtifactManifest;
  readonly emptyPatchRepresentation: typeof PHASE49_CANONICAL_EMPTY_PATCH;
  readonly patchChecksumSha256Hex: typeof PHASE49_CANONICAL_EMPTY_PATCH_SHA256_HEX;
  readonly envelopeChecksumSha256Hex: string;
}

/**
 * Converts the immutable Phase 48 handoff into the ordinary Phase 49 single
 * artifact. This is intentionally a thin contract adapter: persistence remains
 * owned by Phase49S3ArtifactPersistence and is identical to changes_ready.
 */
export function buildPhase49NoChangesArtifact(
  handoff: Phase49DevelopmentHandoffInput,
): Phase49BuiltArtifact {
  assertNoChangesHandoff(handoff);

  const artifact = buildPhase49ArtifactFromDevelopmentHandoff(handoff);
  assertCanonicalNoChangesArtifact(artifact);
  return artifact;
}

/**
 * Validates the canonical body returned from the normal Phase 49 GetObject full
 * verification path. This keeps no_changes semantic validation explicit for
 * Independent Verification without introducing a second storage format.
 */
export function assertPhase49NoChangesArtifactDocument(
  document: Phase49ArtifactEnvelopeDocument,
): void {
  if (document.manifest.outcome !== "no_changes") {
    throw new Error("Phase 49 no_changes artifact manifest outcome is not no_changes");
  }
  if (document.manifest.changedFiles.length !== 0) {
    throw new Error("Phase 49 no_changes artifact manifest contains changed files");
  }
  if (document.patch !== PHASE49_CANONICAL_EMPTY_PATCH) {
    throw new Error("Phase 49 no_changes artifact patch is not the canonical empty representation");
  }
  if (
    document.manifest.patch.checksumSha256Hex !==
    PHASE49_CANONICAL_EMPTY_PATCH_SHA256_HEX
  ) {
    throw new Error("Phase 49 no_changes artifact empty patch checksum is invalid");
  }
}

/**
 * Produces the bounded durable handoff needed by Independent Verification after
 * the generic Phase 49 persistence path has confirmed the object.
 */
export function buildPhase49NoChangesVerificationHandoff(
  artifact: Phase49BuiltArtifact,
  persisted: Phase49PersistedArtifact,
): Phase49NoChangesVerificationHandoff {
  assertCanonicalNoChangesArtifact(artifact);

  const parsed = parsePhase49ArtifactReference(persisted.artifactReference);
  if (parsed.bucket !== persisted.bucket || parsed.key !== persisted.key) {
    throw new Error("Phase 49 no_changes artifact_reference does not match persisted address");
  }

  return Object.freeze({
    executionId: artifact.manifest.executionId,
    issueId: artifact.manifest.issueId,
    repository: artifact.manifest.repository,
    sourceRevision: artifact.manifest.sourceRevision,
    briefRevision: artifact.manifest.briefRevision,
    persistedRevision: artifact.manifest.persistedRevision,
    requirementsFingerprint: artifact.manifest.requirementsFingerprint,
    outcome: "no_changes",
    artifactReference: persisted.artifactReference,
    canonicalManifest: artifact.manifest,
    emptyPatchRepresentation: PHASE49_CANONICAL_EMPTY_PATCH,
    patchChecksumSha256Hex: PHASE49_CANONICAL_EMPTY_PATCH_SHA256_HEX,
    envelopeChecksumSha256Hex: artifact.envelopeChecksumSha256Hex,
  });
}

function assertNoChangesHandoff(handoff: Phase49DevelopmentHandoffInput): void {
  if (handoff.provisionalOutcome !== "no_changes") {
    throw new Error("Phase 49 no_changes artifact builder requires provisional no_changes");
  }
  if (handoff.changedFiles.length !== 0) {
    throw new Error("Phase 49 no_changes artifact builder rejects changed files");
  }
  if (handoff.localChangeSet.patch.truncated) {
    throw new Error("Phase 49 no_changes artifact builder rejects a truncated patch capture");
  }
  if (
    handoff.localChangeSet.patch.text !== PHASE49_CANONICAL_EMPTY_PATCH ||
    handoff.localChangeSet.patch.capturedBytes !== 0
  ) {
    throw new Error("Phase 49 no_changes artifact builder requires canonical empty patch bytes");
  }
}

function assertCanonicalNoChangesArtifact(artifact: Phase49BuiltArtifact): void {
  if (artifact.manifest.outcome !== "no_changes") {
    throw new Error("Phase 49 no_changes artifact outcome changed unexpectedly");
  }
  if (artifact.manifest.changedFiles.length !== 0) {
    throw new Error("Phase 49 no_changes artifact contains changed files");
  }
  if (artifact.sizeBytes <= 0 || artifact.body.byteLength <= 0) {
    throw new Error("Phase 49 no_changes must be a durable artifact, not artifact absence");
  }
  if (
    artifact.patchChecksumSha256Hex !== PHASE49_CANONICAL_EMPTY_PATCH_SHA256_HEX ||
    artifact.manifest.patch.checksumSha256Hex !== PHASE49_CANONICAL_EMPTY_PATCH_SHA256_HEX ||
    artifact.metadata["patch-checksum"] !== PHASE49_CANONICAL_EMPTY_PATCH_SHA256_HEX
  ) {
    throw new Error("Phase 49 no_changes artifact empty patch checksum is invalid");
  }
  if (artifact.metadata.outcome !== "no_changes") {
    throw new Error("Phase 49 no_changes artifact metadata outcome mismatch");
  }

  const document = verifyPhase49ArtifactBody(artifact.body, artifact);
  assertPhase49NoChangesArtifactDocument(document);
}
