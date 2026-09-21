import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAwsPhase49GetObjectInput,
  buildAwsPhase49HeadObjectInput,
  buildAwsPhase49PutObjectInput,
} from "../../src/artifact/aws-s3-client.js";
import type {
  Phase49S3GetInput,
  Phase49S3HeadInput,
  Phase49S3PutInput,
} from "../../src/artifact/s3-persistence.js";

void describe("Phase 49-2 AWS S3 adapter request mapping", () => {
  void it("maps persistence to a single conditional PutObject request", () => {
    const input: Phase49S3PutInput = {
      bucket: "phase49-artifacts-example",
      key: "phase49/artifacts/123e4567-e89b-42d3-a456-426614174000.json",
      body: Buffer.from("{}", "utf8"),
      metadata: {
        "artifact-format-version": "phase49.single.v1",
        "execution-id": "123e4567-e89b-42d3-a456-426614174000",
        "issue-id": "5419",
        repository: "bWNwLW1hbW9ubzIxMC9haS1hZ2VudC1ydW5uZXI",
        "source-revision": "YWFhYQ",
        "brief-revision": "8",
        "persisted-revision": "cGVyc2lzdGVkLXJldmlzaW9uLTg",
        "requirements-fingerprint": "c2hhMjU2OmJiYmI",
        outcome: "changes_ready",
        "patch-checksum": "a".repeat(64),
      },
      checksumAlgorithm: "SHA256",
      checksumSha256Base64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      ifNoneMatch: "*",
      serverSideEncryption: "AES256",
      expectedBucketOwner: "123456789012",
    };

    const mapped = buildAwsPhase49PutObjectInput(input);

    assert.equal(mapped.Bucket, input.bucket);
    assert.equal(mapped.Key, input.key);
    assert.equal(mapped.IfNoneMatch, "*");
    assert.equal(mapped.ChecksumAlgorithm, "SHA256");
    assert.equal(mapped.ChecksumSHA256, input.checksumSha256Base64);
    assert.equal(mapped.ServerSideEncryption, "AES256");
    assert.equal(mapped.ExpectedBucketOwner, "123456789012");
    assert.equal(mapped.ContentType, "application/vnd.mcp.phase49-artifact+json");
    assert.deepEqual(mapped.Metadata, input.metadata);
  });

  void it("always enables checksum retrieval for HeadObject and GetObject", () => {
    const head: Phase49S3HeadInput = {
      bucket: "phase49-artifacts-example",
      key: "phase49/artifacts/id.json",
      checksumMode: "ENABLED",
      expectedBucketOwner: "123456789012",
    };
    const get: Phase49S3GetInput = { ...head };

    assert.deepEqual(buildAwsPhase49HeadObjectInput(head), {
      Bucket: head.bucket,
      Key: head.key,
      ChecksumMode: "ENABLED",
      ExpectedBucketOwner: "123456789012",
    });
    assert.deepEqual(buildAwsPhase49GetObjectInput(get), {
      Bucket: get.bucket,
      Key: get.key,
      ChecksumMode: "ENABLED",
      ExpectedBucketOwner: "123456789012",
    });
  });
});
