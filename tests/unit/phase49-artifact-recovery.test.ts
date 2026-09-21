import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPhase49Artifact } from "../../src/artifact/contract.js";
import {
  PHASE49_DEFAULT_S3_PREFIX,
  Phase49S3ArtifactPersistence,
  Phase49S3OperationError,
  type Phase49ArtifactIdentity,
  type Phase49S3GetInput,
  type Phase49S3GetObservation,
  type Phase49S3HeadInput,
  type Phase49S3ObjectClient,
  type Phase49S3ObjectObservation,
  type Phase49S3PutInput,
} from "../../src/artifact/s3-persistence.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

void describe("Phase 49-5 existing artifact recovery", () => {
  void it("recovers a canonical durable artifact from deterministic address without local patch state", async () => {
    const artifact = artifactFixture();
    const client = new RecoveryFakeS3Client(artifact);
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    const recovered = await persistence.recoverAndVerify(identityFrom(artifact));

    assert.equal(recovered.artifact.manifest.executionId, EXECUTION_ID);
    assert.equal(recovered.artifact.envelopeChecksumSha256Hex, artifact.envelopeChecksumSha256Hex);
    assert.equal(recovered.document.patch, PATCH);
    assert.equal(recovered.persisted.adoptedExistingObject, true);
    assert.equal(client.heads.length, 1);
    assert.equal(client.gets.length, 1);
    assert.equal(client.heads[0]!.checksumMode, "ENABLED");
    assert.equal(client.gets[0]!.checksumMode, "ENABLED");
  });

  void it("fails closed before GetObject when HeadObject checksum is missing", async () => {
    const artifact = artifactFixture();
    const client = new RecoveryFakeS3Client(artifact);
    client.headOverride = { ...client.matchingObservation(), checksumSha256Base64: undefined };
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    await assert.rejects(
      persistence.recoverAndVerify(identityFrom(artifact)),
      /ChecksumSHA256 is missing/u,
    );
    assert.equal(client.gets.length, 0);
  });

  void it("fails closed when required metadata is missing", async () => {
    const artifact = artifactFixture();
    const client = new RecoveryFakeS3Client(artifact);
    const metadata: Record<string, string | undefined> = { ...artifact.metadata };
    delete metadata["source-revision"];
    client.headOverride = { ...client.matchingObservation(), metadata };
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    await assert.rejects(
      persistence.recoverAndVerify(identityFrom(artifact)),
      /metadata field set mismatch|required metadata/u,
    );
  });

  void it("rejects metadata/body mismatch instead of treating metadata as Source of Truth", async () => {
    const artifact = artifactFixture();
    const client = new RecoveryFakeS3Client(artifact);
    client.headOverride = {
      ...client.matchingObservation(),
      metadata: { ...artifact.metadata, repository: "bWlzbWF0Y2g" },
    };
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    await assert.rejects(
      persistence.recoverAndVerify(identityFrom(artifact)),
      /metadata mismatch/u,
    );
  });

  void it("rejects an artifact whose canonical manifest does not match the Agent Running identity", async () => {
    const artifact = artifactFixture();
    const client = new RecoveryFakeS3Client(artifact);
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });
    const staleIdentity: Phase49ArtifactIdentity = {
      ...identityFrom(artifact),
      sourceRevision: "c".repeat(40),
    };

    await assert.rejects(
      persistence.recoverAndVerify(staleIdentity),
      /does not match Agent Running execution/u,
    );
  });

  void it("recovers no_changes as a real durable empty artifact", async () => {
    const artifact = buildPhase49Artifact({
      ...artifactInput(),
      outcome: "no_changes",
      changedFiles: [],
      patch: { text: "", capturedBytes: 0, truncated: false },
    });
    const client = new RecoveryFakeS3Client(artifact);
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    const recovered = await persistence.recoverAndVerify(identityFrom(artifact));

    assert.equal(recovered.document.manifest.outcome, "no_changes");
    assert.equal(recovered.document.patch, "");
    assert.ok(recovered.artifact.sizeBytes > 0);
  });

  void it("preserves explicit not_found so startup reconciliation can use the Phase 48 interrupted fallback", async () => {
    const artifact = artifactFixture();
    const client = new RecoveryFakeS3Client(artifact);
    client.headError = new Phase49S3OperationError("not_found", "not found");
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    await assert.rejects(
      persistence.recoverAndVerify(identityFrom(artifact)),
      (error: unknown) => error instanceof Phase49S3OperationError && error.kind === "not_found",
    );
  });
});

class RecoveryFakeS3Client implements Phase49S3ObjectClient {
  readonly heads: Phase49S3HeadInput[] = [];
  readonly gets: Phase49S3GetInput[] = [];
  readonly #artifact: ReturnType<typeof artifactFixture>;
  headOverride: Phase49S3ObjectObservation | undefined;
  headError: Error | undefined;

  constructor(artifact: ReturnType<typeof artifactFixture>) {
    this.#artifact = artifact;
  }

  putObject(_input: Phase49S3PutInput): Promise<void> {
    return Promise.resolve();
  }

  headObject(input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation> {
    this.heads.push(input);
    if (this.headError !== undefined) {
      return Promise.reject(this.headError);
    }
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

function artifactFixture() {
  return buildPhase49Artifact(artifactInput());
}

function artifactInput() {
  return {
    executionId: EXECUTION_ID,
    issueId: 5422,
    repository: "mcp-mamono210/ai-agent-runner",
    sourceRevision: "a".repeat(40),
    briefRevision: 11,
    persistedRevision: "persisted-revision-11",
    requirementsFingerprint: `sha256:${"b".repeat(64)}`,
    outcome: "changes_ready" as const,
    changedFiles: [{ path: "a.txt", status: "modified" as const }],
    patch: {
      text: PATCH,
      capturedBytes: Buffer.byteLength(PATCH, "utf8"),
      truncated: false,
    },
  };
}

function identityFrom(artifact: ReturnType<typeof artifactFixture>): Phase49ArtifactIdentity {
  return Object.freeze({
    executionId: artifact.manifest.executionId,
    issueId: artifact.manifest.issueId,
    repository: artifact.manifest.repository,
    sourceRevision: artifact.manifest.sourceRevision,
    briefRevision: artifact.manifest.briefRevision,
    persistedRevision: artifact.manifest.persistedRevision,
    requirementsFingerprint: artifact.manifest.requirementsFingerprint,
  });
}
