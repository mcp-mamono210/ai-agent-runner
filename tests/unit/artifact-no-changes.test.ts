import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Phase49DevelopmentHandoffInput } from "../../src/artifact/contract.js";
import {
  PHASE49_CANONICAL_EMPTY_PATCH,
  PHASE49_CANONICAL_EMPTY_PATCH_SHA256_HEX,
  PHASE49_NO_CHANGES_VALIDATION_FAILURE_OUTCOME,
  assertPhase49NoChangesArtifactDocument,
  buildPhase49NoChangesArtifact,
  buildPhase49NoChangesVerificationHandoff,
} from "../../src/artifact/no-changes.js";
import {
  PHASE49_DEFAULT_S3_PREFIX,
  Phase49S3ArtifactPersistence,
  Phase49S3OperationError,
  type Phase49S3GetInput,
  type Phase49S3GetObservation,
  type Phase49S3HeadInput,
  type Phase49S3ObjectClient,
  type Phase49S3ObjectObservation,
  type Phase49S3PutInput,
} from "../../src/artifact/s3-persistence.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";

void describe("Phase 49-3 no_changes / empty artifact contract", () => {
  void it("builds a non-absent single artifact around the canonical empty patch", () => {
    const artifact = buildPhase49NoChangesArtifact(handoff());

    assert.equal(artifact.manifest.outcome, "no_changes");
    assert.deepEqual(artifact.manifest.changedFiles, []);
    assert.ok(artifact.sizeBytes > 0);
    assert.ok(artifact.body.byteLength > 0);
    assert.equal(artifact.patchChecksumSha256Hex, PHASE49_CANONICAL_EMPTY_PATCH_SHA256_HEX);
    assert.equal(
      artifact.manifest.patch.checksumSha256Hex,
      PHASE49_CANONICAL_EMPTY_PATCH_SHA256_HEX,
    );
    assert.equal(artifact.metadata.outcome, "no_changes");
    assert.equal(artifact.metadata["patch-checksum"], PHASE49_CANONICAL_EMPTY_PATCH_SHA256_HEX);
    assert.match(artifact.envelopeChecksumSha256Hex, /^[0-9a-f]{64}$/u);
    assert.match(artifact.bodyUtf8, /"outcome":"no_changes"/u);
    assert.match(artifact.bodyUtf8, /"patch":""/u);
  });

  void it("rejects changes_ready at the no_changes contract boundary", () => {
    assert.throws(
      () => buildPhase49NoChangesArtifact({ ...handoff(), provisionalOutcome: "changes_ready" }),
      /requires provisional no_changes/u,
    );
  });

  void it("rejects no_changes with changed files", () => {
    assert.throws(
      () => buildPhase49NoChangesArtifact({
        ...handoff(),
        changedFiles: [{ path: "unexpected.txt", status: "untracked" }],
      }),
      /rejects changed files/u,
    );
  });

  void it("rejects no_changes with a non-empty or non-canonical patch capture", () => {
    assert.throws(
      () => buildPhase49NoChangesArtifact({
        ...handoff(),
        localChangeSet: {
          patch: { text: "unexpected", capturedBytes: 10, truncated: false },
        },
      }),
      /requires canonical empty patch bytes/u,
    );

    assert.throws(
      () => buildPhase49NoChangesArtifact({
        ...handoff(),
        localChangeSet: {
          patch: { text: PHASE49_CANONICAL_EMPTY_PATCH, capturedBytes: 1, truncated: false },
        },
      }),
      /requires canonical empty patch bytes/u,
    );
  });

  void it("uses the Phase 49-1 canonical failure outcome for validation failures", () => {
    assert.equal(
      PHASE49_NO_CHANGES_VALIDATION_FAILURE_OUTCOME,
      "artifact_persistence_failed",
    );
  });

  void it("reuses Phase 49-2 Put/Head/Get persistence and exposes verification handoff data", async () => {
    const artifact = buildPhase49NoChangesArtifact(handoff());
    const client = new FakeS3Client(artifact);
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    const persisted = await persistence.persistAndConfirm(artifact);

    assert.equal(client.puts.length, 1);
    assert.equal(client.puts[0]!.ifNoneMatch, "*");
    assert.equal(client.puts[0]!.metadata.outcome, "no_changes");
    assert.ok(client.puts[0]!.body.byteLength > 0);
    assert.equal(client.heads.length, 1);
    assert.equal(client.heads[0]!.checksumMode, "ENABLED");

    const document = await persistence.getAndVerify(persisted.artifactReference, artifact);
    assertPhase49NoChangesArtifactDocument(document);
    assert.equal(client.gets.length, 1);
    assert.equal(client.gets[0]!.checksumMode, "ENABLED");

    const verification = buildPhase49NoChangesVerificationHandoff(artifact, persisted);
    assert.equal(verification.executionId, EXECUTION_ID);
    assert.equal(verification.sourceRevision, "a".repeat(40));
    assert.equal(verification.briefRevision, 9);
    assert.equal(verification.persistedRevision, "persisted-revision-9");
    assert.equal(verification.requirementsFingerprint, `sha256:${"b".repeat(64)}`);
    assert.equal(verification.outcome, "no_changes");
    assert.equal(verification.artifactReference, persisted.artifactReference);
    assert.equal(verification.canonicalManifest, artifact.manifest);
    assert.equal(verification.emptyPatchRepresentation, PHASE49_CANONICAL_EMPTY_PATCH);
    assert.equal(
      verification.patchChecksumSha256Hex,
      PHASE49_CANONICAL_EMPTY_PATCH_SHA256_HEX,
    );
    assert.equal(verification.envelopeChecksumSha256Hex, artifact.envelopeChecksumSha256Hex);
  });

  void it("reuses Phase 49-2 ambiguous-write recovery for no_changes", async () => {
    const artifact = buildPhase49NoChangesArtifact(handoff());
    const client = new FakeS3Client(artifact);
    client.putError = new Phase49S3OperationError("ambiguous", "response lost");
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    const persisted = await persistence.persistAndConfirm(artifact);

    assert.equal(persisted.adoptedExistingObject, true);
    assert.equal(client.heads.length, 1);
    assert.equal(client.heads[0]!.checksumMode, "ENABLED");
  });

  void it("fails closed when no_changes durable verification data is missing", async () => {
    const artifact = buildPhase49NoChangesArtifact(handoff());
    const client = new FakeS3Client(artifact);
    client.headOverride = {
      ...client.matchingObservation(),
      checksumSha256Base64: undefined,
    };
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    await assert.rejects(
      persistence.persistAndConfirm(artifact),
      /ChecksumSHA256 is missing/u,
    );
  });

  void it("rejects a non-empty patch presented as a no_changes verification document", () => {
    const artifact = buildPhase49NoChangesArtifact(handoff());
    const document = {
      manifest: artifact.manifest,
      patch: "unexpected",
    };

    assert.throws(
      () => assertPhase49NoChangesArtifactDocument(document),
      /not the canonical empty representation/u,
    );
  });
});

class FakeS3Client implements Phase49S3ObjectClient {
  readonly puts: Phase49S3PutInput[] = [];
  readonly heads: Phase49S3HeadInput[] = [];
  readonly gets: Phase49S3GetInput[] = [];
  readonly #artifact: ReturnType<typeof buildPhase49NoChangesArtifact>;
  putError: Error | undefined;
  headOverride: Phase49S3ObjectObservation | undefined;

  constructor(artifact: ReturnType<typeof buildPhase49NoChangesArtifact>) {
    this.#artifact = artifact;
  }

  putObject(input: Phase49S3PutInput): Promise<void> {
    this.puts.push(input);
    if (this.putError !== undefined) {
      return Promise.reject(this.putError);
    }
    return Promise.resolve();
  }

  headObject(input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation> {
    this.heads.push(input);
    return Promise.resolve(this.headOverride ?? this.matchingObservation());
  }

  getObject(input: Phase49S3GetInput): Promise<Phase49S3GetObservation> {
    this.gets.push(input);
    return Promise.resolve({ ...this.matchingObservation(), body: this.#artifact.body });
  }

  matchingObservation(): Phase49S3ObjectObservation {
    return {
      checksumType: "FULL_OBJECT",
      checksumSha256Base64: this.#artifact.envelopeChecksumSha256Base64,
      metadata: { ...this.#artifact.metadata },
      serverSideEncryption: "AES256",
      versionId: undefined,
      contentLength: this.#artifact.sizeBytes,
    };
  }
}

function configFixture() {
  return Object.freeze({
    region: "ap-northeast-1",
    bucket: "phase49-artifacts-example",
    prefix: PHASE49_DEFAULT_S3_PREFIX,
    expectedBucketOwner: "123456789012",
  });
}

function handoff(): Phase49DevelopmentHandoffInput {
  return {
    executionId: EXECUTION_ID,
    issueId: 5420,
    repository: "mcp-mamono210/ai-agent-runner",
    sourceRevision: "a".repeat(40),
    briefRevision: 9,
    persistedRevision: "persisted-revision-9",
    requirementsFingerprint: `sha256:${"b".repeat(64)}`,
    provisionalOutcome: "no_changes",
    changedFiles: [],
    localChangeSet: {
      patch: {
        text: PHASE49_CANONICAL_EMPTY_PATCH,
        capturedBytes: 0,
        truncated: false,
      },
    },
  };
}
