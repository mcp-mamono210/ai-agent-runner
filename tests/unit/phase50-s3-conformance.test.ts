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
import { assertPhase50EnvironmentCoverageClosed } from "../../src/verification/phase50-conformance.js";
import { runPhase50S3Conformance } from "../../src/verification/phase50-s3-conformance.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";

void describe("Phase 50-2 S3 conformance run isolation", () => {
  void it("can repeat the same configured execution ID without colliding with a previous probe run", async () => {
    const client = new InMemoryS3Client();
    const input = {
      client,
      config: {
        region: "ap-northeast-1",
        bucket: "phase50-example",
        prefix: "phase50/conformance",
      },
      executionId: EXECUTION_ID,
      issueId: 5426,
      repository: "mcp-mamono210/ai-agent-runner",
      sourceRevision: "a".repeat(40),
    } as const;

    const first = await runPhase50S3Conformance(input);
    const second = await runPhase50S3Conformance(input);

    assert.doesNotThrow(() => assertPhase50EnvironmentCoverageClosed(first));
    assert.doesNotThrow(() => assertPhase50EnvironmentCoverageClosed(second));
    assert.equal(client.keys.length, 2);
    assert.equal(new Set(client.keys).size, 2);
    for (const key of client.keys) {
      assert.match(
        key,
        new RegExp(`^phase50/conformance/runs/[0-9a-f-]+/${EXECUTION_ID}\\.json$`, "u"),
      );
    }
  });
});

interface StoredObject {
  readonly body: Uint8Array;
  readonly metadata: Readonly<Record<string, string>>;
  readonly checksumSha256Base64: string;
  readonly serverSideEncryption: string;
}

class InMemoryS3Client implements Phase49S3ObjectClient {
  readonly #objects = new Map<string, StoredObject>();

  get keys(): readonly string[] {
    return [...this.#objects.keys()];
  }

  putObject(input: Phase49S3PutInput): Promise<void> {
    if (this.#objects.has(input.key)) {
      return Promise.reject(new Phase49S3OperationError(
        "conflict",
        "conditional object already exists",
      ));
    }
    this.#objects.set(input.key, Object.freeze({
      body: Uint8Array.from(input.body),
      metadata: Object.freeze({ ...input.metadata }),
      checksumSha256Base64: input.checksumSha256Base64,
      serverSideEncryption: input.serverSideEncryption,
    }));
    return Promise.resolve();
  }

  headObject(input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation> {
    const stored = this.#required(input.key);
    return Promise.resolve(Object.freeze({
      checksumType: "FULL_OBJECT",
      checksumSha256Base64: stored.checksumSha256Base64,
      metadata: stored.metadata,
      serverSideEncryption: stored.serverSideEncryption,
      contentLength: stored.body.byteLength,
    }));
  }

  getObject(input: Phase49S3GetInput): Promise<Phase49S3GetObservation> {
    const stored = this.#required(input.key);
    return Promise.resolve(Object.freeze({
      checksumType: "FULL_OBJECT",
      checksumSha256Base64: stored.checksumSha256Base64,
      metadata: stored.metadata,
      serverSideEncryption: stored.serverSideEncryption,
      contentLength: stored.body.byteLength,
      body: Uint8Array.from(stored.body),
    }));
  }

  #required(key: string): StoredObject {
    const stored = this.#objects.get(key);
    if (stored === undefined) {
      throw new Phase49S3OperationError("not_found", `missing object: ${key}`);
    }
    return stored;
  }
}
