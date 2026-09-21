import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPhase49Artifact } from "../../src/artifact/contract.js";
import {
  PHASE49_DEFAULT_S3_PREFIX,
  PHASE49_S3_SERVER_SIDE_ENCRYPTION,
  Phase49S3ArtifactPersistence,
  Phase49S3OperationError,
  formatPhase49ArtifactReference,
  loadPhase49S3RuntimeConfig,
  parsePhase49ArtifactReference,
  phase49ArtifactObjectKey,
  type Phase49S3GetInput,
  type Phase49S3GetObservation,
  type Phase49S3HeadInput,
  type Phase49S3ObjectClient,
  type Phase49S3ObjectObservation,
  type Phase49S3PutInput,
} from "../../src/artifact/s3-persistence.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

void describe("Phase 49-2 S3 artifact persistence", () => {
  void it("uses direct conditional PutObject and confirms through checksum-enabled HeadObject", async () => {
    const artifact = artifactFixture();
    const client = new FakeS3Client(artifact);
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    const persisted = await persistence.persistAndConfirm(artifact);

    assert.equal(client.puts.length, 1);
    const put = client.puts[0]!;
    assert.equal(put.ifNoneMatch, "*");
    assert.equal(put.checksumAlgorithm, "SHA256");
    assert.equal(put.checksumSha256Base64, artifact.envelopeChecksumSha256Base64);
    assert.equal(put.serverSideEncryption, PHASE49_S3_SERVER_SIDE_ENCRYPTION);
    assert.deepEqual(put.metadata, artifact.metadata);
    assert.equal(client.heads.length, 1);
    assert.equal(client.heads[0]!.checksumMode, "ENABLED");
    assert.equal(persisted.adoptedExistingObject, false);
    assert.equal(
      persisted.artifactReference,
      `s3://phase49-artifacts-example/${PHASE49_DEFAULT_S3_PREFIX}/${EXECUTION_ID}.json`,
    );
  });

  void it("adopts an existing matching object after a conditional conflict", async () => {
    const artifact = artifactFixture();
    const client = new FakeS3Client(artifact);
    client.putError = new Phase49S3OperationError("conflict", "already exists");
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    const persisted = await persistence.persistAndConfirm(artifact);

    assert.equal(persisted.adoptedExistingObject, true);
    assert.equal(client.heads.length, 1);
  });

  void it("adopts an existing matching object after an ambiguous write result", async () => {
    const artifact = artifactFixture();
    const client = new FakeS3Client(artifact);
    client.putError = new Phase49S3OperationError("ambiguous", "response lost");
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    const persisted = await persistence.persistAndConfirm(artifact);

    assert.equal(persisted.adoptedExistingObject, true);
  });

  void it("does not adopt an existing object when checksum differs", async () => {
    const artifact = artifactFixture();
    const client = new FakeS3Client(artifact);
    client.putError = new Phase49S3OperationError("conflict", "already exists");
    client.headOverride = { ...client.matchingObservation(), checksumSha256Base64: "wrong" };
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    await assert.rejects(persistence.persistAndConfirm(artifact), /envelope checksum mismatch/u);
  });

  void it("fails closed when checksum is absent", async () => {
    const artifact = artifactFixture();
    const client = new FakeS3Client(artifact);
    client.headOverride = { ...client.matchingObservation(), checksumSha256Base64: undefined };
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    await assert.rejects(persistence.persistAndConfirm(artifact), /ChecksumSHA256 is missing/u);
  });

  void it("fails closed when a required metadata field is absent", async () => {
    const artifact = artifactFixture();
    const client = new FakeS3Client(artifact);
    const metadata: Record<string, string | undefined> = { ...artifact.metadata };
    delete metadata["source-revision"];
    client.headOverride = { ...client.matchingObservation(), metadata };
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    await assert.rejects(persistence.persistAndConfirm(artifact), /metadata field set mismatch|required metadata/u);
  });

  void it("requires SSE-S3 and disabled versioning baseline", async () => {
    const artifact = artifactFixture();
    const client = new FakeS3Client(artifact);
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });

    client.headOverride = { ...client.matchingObservation(), serverSideEncryption: "aws:kms" };
    await assert.rejects(persistence.persistAndConfirm(artifact), /SSE-S3 AES256/u);

    client.headOverride = { ...client.matchingObservation(), versionId: "version-1" };
    await assert.rejects(persistence.persistAndConfirm(artifact), /versioning baseline is not disabled/u);
  });

  void it("performs full GetObject verification without reserializing a local replacement", async () => {
    const artifact = artifactFixture();
    const client = new FakeS3Client(artifact);
    const persistence = new Phase49S3ArtifactPersistence({ client, config: configFixture() });
    const persisted = await persistence.persistAndConfirm(artifact);

    const document = await persistence.getAndVerify(persisted.artifactReference, artifact);

    assert.equal(document.manifest.executionId, EXECUTION_ID);
    assert.equal(document.patch, PATCH);
    assert.equal(client.gets.length, 1);
    assert.equal(client.gets[0]!.checksumMode, "ENABLED");
  });

  void it("derives deterministic object address without a ListBucket operation", () => {
    const config = configFixture();
    const key = phase49ArtifactObjectKey(config, EXECUTION_ID);
    const reference = formatPhase49ArtifactReference(config.bucket, key);

    assert.equal(key, `${PHASE49_DEFAULT_S3_PREFIX}/${EXECUTION_ID}.json`);
    assert.deepEqual(parsePhase49ArtifactReference(reference), { bucket: config.bucket, key });
  });

  void it("loads bounded production configuration and validates expected bucket owner", () => {
    assert.deepEqual(loadPhase49S3RuntimeConfig({
      AGENT_RUNNER_ARTIFACT_S3_REGION: "ap-northeast-1",
      AGENT_RUNNER_ARTIFACT_S3_BUCKET: "phase49-artifacts-example",
      AGENT_RUNNER_ARTIFACT_S3_EXPECTED_BUCKET_OWNER: "123456789012",
    }), {
      region: "ap-northeast-1",
      bucket: "phase49-artifacts-example",
      prefix: PHASE49_DEFAULT_S3_PREFIX,
      expectedBucketOwner: "123456789012",
    });

    assert.throws(() => loadPhase49S3RuntimeConfig({
      AGENT_RUNNER_ARTIFACT_S3_REGION: "ap-northeast-1",
      AGENT_RUNNER_ARTIFACT_S3_BUCKET: "phase49-artifacts-example",
      AGENT_RUNNER_ARTIFACT_S3_EXPECTED_BUCKET_OWNER: "bad",
    }), /12-digit AWS account ID/u);
  });
});

class FakeS3Client implements Phase49S3ObjectClient {
  readonly puts: Phase49S3PutInput[] = [];
  readonly heads: Phase49S3HeadInput[] = [];
  readonly gets: Phase49S3GetInput[] = [];
  readonly #artifact: ReturnType<typeof artifactFixture>;
  putError: Error | undefined;
  headOverride: Phase49S3ObjectObservation | undefined;

  constructor(artifact: ReturnType<typeof artifactFixture>) {
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

function artifactFixture() {
  return buildPhase49Artifact({
    executionId: EXECUTION_ID,
    issueId: 5419,
    repository: "mcp-mamono210/ai-agent-runner",
    sourceRevision: "a".repeat(40),
    briefRevision: 8,
    persistedRevision: "persisted-revision-8",
    requirementsFingerprint: `sha256:${"b".repeat(64)}`,
    outcome: "changes_ready",
    changedFiles: [{ path: "a.txt", status: "modified" }],
    patch: {
      text: PATCH,
      capturedBytes: Buffer.byteLength(PATCH, "utf8"),
      truncated: false,
    },
  });
}
