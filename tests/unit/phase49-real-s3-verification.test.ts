import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  Phase49S3OperationError,
  type Phase49S3GetInput,
  type Phase49S3GetObservation,
  type Phase49S3HeadInput,
  type Phase49S3ObjectClient,
  type Phase49S3ObjectObservation,
  type Phase49S3PutInput,
} from "../../src/artifact/s3-persistence.js";
import { runPhase49RealS3Verification } from "../../src/verification/phase49-real-s3.js";

void describe("Phase 49-5 real S3 verification harness", () => {
  void it("records PASS only after conditional create, Head/Get verification, no_changes, incompatible overwrite rejection, and ambiguous recovery", async () => {
    const record = await runPhase49RealS3Verification({
      config: {
        region: "ap-northeast-1",
        bucket: "phase49-artifacts-example",
        prefix: "phase49/verification/unit",
        expectedBucketOwner: "123456789012",
      },
      client: new InMemoryS3Client(),
      testedGitRevision: "a".repeat(40),
      repository: "mcp-mamono210/ai-agent-runner",
      issueId: 5422,
      retentionDays: 30,
      iamBoundaryAttested: true,
      now: () => new Date("2026-09-21T04:30:00Z"),
    });

    assert.equal(record.result, "PASS");
    assert.equal(record.uploadMode, "direct PutObject");
    assert.equal(record.checksumMode, "ENABLED");
    assert.equal(record.conditionalWrite, "If-None-Match:*");
    assert.equal(record.encryption, "AES256");
    assert.equal(record.artifactReferences.length, 3);
    assert.equal(record.verifiedScenarios.some((entry) => entry.includes("ambiguous")), true);
  });

  void it("refuses to claim PASS without retention and IAM deployment attestation", async () => {
    const base = {
      config: {
        region: "ap-northeast-1",
        bucket: "phase49-artifacts-example",
        prefix: "phase49/verification/unit",
      },
      client: new InMemoryS3Client(),
      testedGitRevision: "a".repeat(40),
      repository: "mcp-mamono210/ai-agent-runner",
      issueId: 5422,
    } as const;

    await assert.rejects(
      runPhase49RealS3Verification({ ...base, retentionDays: 29, iamBoundaryAttested: true }),
      /retention must be at least 30 days/u,
    );
    await assert.rejects(
      runPhase49RealS3Verification({ ...base, retentionDays: 30, iamBoundaryAttested: false }),
      /IAM boundary attestation/u,
    );
  });
});

interface StoredObject {
  readonly body: Uint8Array;
  readonly metadata: Readonly<Record<string, string | undefined>>;
  readonly checksumSha256Base64: string;
  readonly serverSideEncryption: string;
}

class InMemoryS3Client implements Phase49S3ObjectClient {
  readonly #objects = new Map<string, StoredObject>();

  putObject(input: Phase49S3PutInput): Promise<void> {
    const address = `${input.bucket}/${input.key}`;
    if (this.#objects.has(address)) {
      return Promise.reject(new Phase49S3OperationError("conflict", "existing object"));
    }
    this.#objects.set(address, {
      body: Uint8Array.from(input.body),
      metadata: { ...input.metadata },
      checksumSha256Base64: input.checksumSha256Base64,
      serverSideEncryption: input.serverSideEncryption,
    });
    return Promise.resolve();
  }

  headObject(input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation> {
    const object = this.#objects.get(`${input.bucket}/${input.key}`);
    if (object === undefined) {
      return Promise.reject(new Phase49S3OperationError("not_found", "not found"));
    }
    return Promise.resolve(this.#observation(object));
  }

  getObject(input: Phase49S3GetInput): Promise<Phase49S3GetObservation> {
    const object = this.#objects.get(`${input.bucket}/${input.key}`);
    if (object === undefined) {
      return Promise.reject(new Phase49S3OperationError("not_found", "not found"));
    }
    return Promise.resolve({ ...this.#observation(object), body: Uint8Array.from(object.body) });
  }

  #observation(object: StoredObject): Phase49S3ObjectObservation {
    return {
      checksumType: "FULL_OBJECT",
      checksumSha256Base64: object.checksumSha256Base64,
      metadata: object.metadata,
      serverSideEncryption: object.serverSideEncryption,
      versionId: undefined,
      contentLength: object.body.byteLength,
    };
  }
}
