import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PHASE49_ARTIFACT_FORMAT_VERSION,
  PHASE49_CANONICAL_FAILURE_OUTCOME,
  PHASE49_MAX_ARTIFACT_BYTES,
  PHASE49_METADATA_BUDGET_BYTES,
  PHASE49_REQUIRED_METADATA_KEYS,
  buildPhase49Artifact,
  buildPhase49ArtifactFromDevelopmentHandoff,
  canonicalArtifactFailureOutcome,
  verifyPhase49ArtifactBody,
  verifyPhase49ArtifactHead,
  type Phase49ArtifactBuildInput,
  type Phase49HeadObservation,
} from "../../src/artifact/contract.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SOURCE_REVISION = "a".repeat(40);
const FINGERPRINT = `sha256:${"b".repeat(64)}`;
const PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

void describe("Phase 49-1 artifact contract", () => {
  void it("builds one canonical artifact from immutable started identity", () => {
    const artifact = buildPhase49Artifact(input());

    assert.equal(artifact.manifest.artifactFormatVersion, PHASE49_ARTIFACT_FORMAT_VERSION);
    assert.equal(artifact.manifest.executionId, EXECUTION_ID);
    assert.equal(artifact.manifest.repository, "mcp-mamono210/例-example");
    assert.equal(artifact.manifest.sourceRevision, SOURCE_REVISION);
    assert.equal(artifact.manifest.requirementsFingerprint, FINGERPRINT);
    assert.equal(artifact.manifest.outcome, "changes_ready");
    assert.deepEqual(artifact.manifest.changedFiles, [
      { path: "src/a.ts", status: "modified" },
      { path: "src/z.ts", status: "untracked" },
    ]);
    assert.equal(artifact.bodyUtf8, Buffer.from(artifact.body).toString("utf8"));
    assert.match(artifact.patchChecksumSha256Hex, /^[0-9a-f]{64}$/u);
    assert.match(artifact.envelopeChecksumSha256Hex, /^[0-9a-f]{64}$/u);
    assert.match(artifact.envelopeChecksumSha256Base64, /^[A-Za-z0-9+/]{43}=$/u);
    assert.equal(artifact.checksumType, "FULL_OBJECT");
    assert.equal(artifact.checksumAlgorithm, "SHA256");
    assert.ok(artifact.sizeBytes < PHASE49_MAX_ARTIFACT_BYTES);
  });

  void it("uses a fixed lowercase kebab-case bounded metadata projection", () => {
    const artifact = buildPhase49Artifact(input());

    assert.deepEqual(Object.keys(artifact.metadata).sort(), [...PHASE49_REQUIRED_METADATA_KEYS].sort());
    for (const [key, value] of Object.entries(artifact.metadata)) {
      assert.equal(key, key.toLowerCase());
      assert.equal(key.includes("_"), false);
      assert.match(value, /^[\x20-\x7e]+$/u);
    }
    assert.equal(artifact.metadata.repository.includes("例"), false);
    assert.ok(artifact.metadataBytes <= PHASE49_METADATA_BUDGET_BYTES);
  });

  void it("rejects an artifact that exceeds the 8 MiB contract limit", () => {
    const oversizedPatch = "x".repeat(PHASE49_MAX_ARTIFACT_BYTES + 1);

    assert.throws(
      () => buildPhase49Artifact({
        ...input(),
        changedFiles: [{ path: "oversized.txt", status: "modified" }],
        patch: {
          text: oversizedPatch,
          capturedBytes: Buffer.byteLength(oversizedPatch, "utf8"),
          truncated: false,
        },
      }),
      /artifact exceeded maximum size/u,
    );
  });

  void it("rejects metadata projection that exceeds the 1536-byte budget", () => {
    assert.throws(
      () => buildPhase49Artifact({
        ...input(),
        repository: `mcp-mamono210/${"r".repeat(PHASE49_METADATA_BUDGET_BYTES * 2)}`,
      }),
      /S3 metadata exceeded budget/u,
    );
  });

  void it("produces identical bytes for semantically identical changed-file order", () => {
    const left = buildPhase49Artifact(input());
    const right = buildPhase49Artifact({
      ...input(),
      changedFiles: [...input().changedFiles].reverse(),
    });

    assert.equal(left.bodyUtf8, right.bodyUtf8);
    assert.equal(left.envelopeChecksumSha256Hex, right.envelopeChecksumSha256Hex);
  });

  void it("round-trips canonical body and verifies the patch checksum", () => {
    const artifact = buildPhase49Artifact(input());
    const verified = verifyPhase49ArtifactBody(artifact.body, artifact);

    assert.equal(verified.manifest.executionId, EXECUTION_ID);
    assert.equal(verified.patch, PATCH);
  });

  void it("rejects body tampering", () => {
    const artifact = buildPhase49Artifact(input());
    const tampered = Buffer.from(artifact.bodyUtf8.replace("+new", "+tampered"), "utf8");

    assert.throws(
      () => verifyPhase49ArtifactBody(tampered, artifact),
      /patch checksum mismatch|envelope checksum mismatch/u,
    );
  });

  void it("verifies HeadObject only when all required inputs are present", () => {
    const artifact = buildPhase49Artifact(input());
    assert.doesNotThrow(() => verifyPhase49ArtifactHead(artifact, head(artifact)));
  });

  void it("fails closed when ChecksumMode was not enabled", () => {
    const artifact = buildPhase49Artifact(input());
    assert.throws(
      () => verifyPhase49ArtifactHead(artifact, { ...head(artifact), checksumModeEnabled: false }),
      /ChecksumMode=ENABLED/u,
    );
  });

  void it("fails closed when ChecksumSHA256 is missing", () => {
    const artifact = buildPhase49Artifact(input());
    assert.throws(
      () => verifyPhase49ArtifactHead(artifact, { ...head(artifact), checksumSha256Base64: undefined }),
      /ChecksumSHA256 is missing/u,
    );
  });

  void it("fails closed when checksum type is not FULL_OBJECT", () => {
    const artifact = buildPhase49Artifact(input());
    assert.throws(
      () => verifyPhase49ArtifactHead(artifact, { ...head(artifact), checksumType: "COMPOSITE" }),
      /not FULL_OBJECT/u,
    );
  });

  void it("fails closed when a required metadata field is missing", () => {
    const artifact = buildPhase49Artifact(input());
    const metadata: Record<string, string | undefined> = { ...artifact.metadata };
    delete metadata["source-revision"];

    assert.throws(
      () => verifyPhase49ArtifactHead(artifact, { ...head(artifact), metadata }),
      /metadata field set mismatch|required metadata/u,
    );
  });

  void it("fails closed when metadata differs", () => {
    const artifact = buildPhase49Artifact(input());
    const metadata = { ...artifact.metadata, outcome: "no_changes" };

    assert.throws(
      () => verifyPhase49ArtifactHead(artifact, { ...head(artifact), metadata }),
      /metadata mismatch: outcome/u,
    );
  });

  void it("rejects truncated Phase 48 patch capture", () => {
    assert.throws(
      () => buildPhase49Artifact({ ...input(), patch: { ...input().patch, truncated: true } }),
      /cannot persist a truncated patch/u,
    );
  });

  void it("rejects mismatched capture byte count", () => {
    assert.throws(
      () => buildPhase49Artifact({ ...input(), patch: { ...input().patch, capturedBytes: 1 } }),
      /byte count does not match/u,
    );
  });

  void it("rejects changes_ready without a restorable patch", () => {
    assert.throws(
      () => buildPhase49Artifact({
        ...input(),
        changedFiles: [{ path: "empty", status: "untracked" }],
        patch: { text: "", capturedBytes: 0, truncated: false },
      }),
      /changes_ready requires/u,
    );
  });

  void it("supports canonical no_changes with an empty patch", () => {
    const artifact = buildPhase49Artifact({
      ...input(),
      outcome: "no_changes",
      changedFiles: [],
      patch: { text: "", capturedBytes: 0, truncated: false },
    });

    assert.equal(artifact.manifest.outcome, "no_changes");
    assert.equal(verifyPhase49ArtifactBody(artifact.body, artifact).patch, "");
  });

  void it("rejects no_changes with changed files", () => {
    assert.throws(
      () => buildPhase49Artifact({ ...input(), outcome: "no_changes" }),
      /no_changes requires/u,
    );
  });

  void it("keeps existing Phase 45 outcome taxonomy for v0.4.0", () => {
    for (const reason of [
      "storage_failure",
      "integrity_failure",
      "artifact_too_large",
      "secret_policy_rejection",
      "result_validation_failure",
    ] as const) {
      assert.equal(canonicalArtifactFailureOutcome(reason), PHASE49_CANONICAL_FAILURE_OUTCOME);
    }
  });

  void it("adapts the Phase 48-7 development handoff without re-reading mutable state", () => {
    const base = input();
    const artifact = buildPhase49ArtifactFromDevelopmentHandoff({
      executionId: base.executionId,
      issueId: base.issueId,
      repository: base.repository,
      sourceRevision: base.sourceRevision,
      briefRevision: base.briefRevision,
      persistedRevision: base.persistedRevision,
      requirementsFingerprint: base.requirementsFingerprint,
      provisionalOutcome: base.outcome,
      changedFiles: base.changedFiles,
      localChangeSet: { patch: base.patch },
    });

    assert.equal(artifact.manifest.executionId, base.executionId);
    assert.equal(artifact.manifest.sourceRevision, base.sourceRevision);
  });
});

function input(): Phase49ArtifactBuildInput {
  return {
    executionId: EXECUTION_ID,
    issueId: 5418,
    repository: "mcp-mamono210/例-example",
    sourceRevision: SOURCE_REVISION,
    briefRevision: 7,
    persistedRevision: "永続-revision-7",
    requirementsFingerprint: FINGERPRINT,
    outcome: "changes_ready",
    changedFiles: [
      { path: "src/z.ts", status: "untracked" },
      { path: "src/a.ts", status: "modified" },
    ],
    patch: {
      text: PATCH,
      capturedBytes: Buffer.byteLength(PATCH, "utf8"),
      truncated: false,
    },
  };
}

function head(artifact: ReturnType<typeof buildPhase49Artifact>): Phase49HeadObservation {
  return {
    checksumModeEnabled: true,
    checksumType: "FULL_OBJECT",
    checksumSha256Base64: artifact.envelopeChecksumSha256Base64,
    metadata: { ...artifact.metadata },
  };
}
