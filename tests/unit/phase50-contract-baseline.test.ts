import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { buildPhase49Artifact } from "../../src/artifact/contract.js";
import {
  PHASE49_S3_SERVER_SIDE_ENCRYPTION,
  Phase49S3ArtifactPersistence,
  type Phase49S3GetInput,
  type Phase49S3GetObservation,
  type Phase49S3HeadInput,
  type Phase49S3ObjectClient,
  type Phase49S3ObjectObservation,
  type Phase49S3PutInput,
} from "../../src/artifact/s3-persistence.js";
import {
  assertExpectedFailureObservation,
  assertNoExpectedFailureMarkers,
  assertPhase50GoldenContractMatches,
  parsePhase50ExpectedFailureRegistry,
  parsePhase50GoldenContract,
  phase50ExampleDeterministicKey,
  projectPhase50CurrentImplementation,
  type Phase50ExpectedFailureEntry,
  type Phase50GoldenContract,
} from "../../src/verification/phase50-contract-baseline.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";

void describe("Phase 50-1 contract baseline", () => {
  void it("matches the canonical golden declarations instead of snapshotting current output", () => {
    const golden = loadGolden();
    const actual = projectPhase50CurrentImplementation();

    assert.doesNotThrow(() => assertPhase50GoldenContractMatches(golden, actual));
    assert.equal(golden.canonicalSources.length >= 7, true);
  });

  void it("rejects an implicit lifecycle taxonomy change", () => {
    const golden = loadGolden();
    const mutated: Phase50GoldenContract = {
      ...golden,
      executionLifecycles: [
        ...golden.executionLifecycles.slice(0, -1),
        "Needs Operator",
      ],
    };

    assert.throws(
      () => assertPhase50GoldenContractMatches(mutated),
      /execution lifecycles/u,
    );
  });

  void it("rejects an implicit outcome-taxonomy expansion", () => {
    const golden = loadGolden();
    const mutated: Phase50GoldenContract = {
      ...golden,
      executionOutcomes: [...golden.executionOutcomes, "unexpected_outcome"],
    };

    assert.throws(
      () => assertPhase50GoldenContractMatches(mutated),
      /execution outcomes/u,
    );
  });

  void it("rejects an implicit artifact manifest schema change", () => {
    const golden = loadGolden();
    const mutated: Phase50GoldenContract = {
      ...golden,
      artifact: {
        ...golden.artifact,
        manifestRequiredKeys: [...golden.artifact.manifestRequiredKeys, "unexpectedField"],
      },
    };

    assert.throws(
      () => assertPhase50GoldenContractMatches(mutated),
      /artifact manifest fields/u,
    );
  });

  void it("rejects an unexpected Controller IAM requirement expansion", () => {
    const golden = loadGolden();
    const mutated: Phase50GoldenContract = {
      ...golden,
      iam: {
        ...golden.iam,
        requiredControllerActions: [
          ...golden.iam.requiredControllerActions,
          "s3:DeleteObject",
        ],
      },
    };

    assert.throws(
      () => assertPhase50GoldenContractMatches(mutated),
      /Controller required IAM actions/u,
    );
  });

  void it("keeps the expected-failure registry empty at the Phase 50-2 entry gate", () => {
    const registry = loadExpectedFailures();
    assert.doesNotThrow(() => assertNoExpectedFailureMarkers(registry));
  });

  void it("accepts only the exact registered failure and treats XPASS/unrelated failure as errors", () => {
    const marker: Phase50ExpectedFailureEntry = {
      testIdentity: "phase50/example",
      blockingDefectIssueId: 9999,
      expectedFailureReason: "canonical mismatch",
      canonicalContractReference: "docs/contracts/example.md#contract",
      detectedDate: "2026-09-21",
    };

    assert.doesNotThrow(() =>
      assertExpectedFailureObservation(marker, {
        kind: "expected_failure",
        observedReason: "canonical mismatch",
      }),
    );
    assert.throws(
      () => assertExpectedFailureObservation(marker, { kind: "unexpected_pass" }),
      /XPASS/u,
    );
    assert.throws(
      () =>
        assertExpectedFailureObservation(marker, {
          kind: "unrelated_failure",
          observedReason: "network unavailable",
        }),
      /unrelated failure/u,
    );
    assert.throws(
      () =>
        assertExpectedFailureObservation(marker, {
          kind: "expected_failure",
          observedReason: "different reason",
        }),
      /unrelated failure/u,
    );
  });

  void it("probes direct conditional PutObject and deterministic execution-id addressing", async () => {
    const artifact = buildPhase49Artifact({
      executionId: EXECUTION_ID,
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
    const client = new RecordingS3Client(artifact);
    const persistence = new Phase49S3ArtifactPersistence({
      client,
      config: {
        region: "ap-northeast-1",
        bucket: "phase50-example",
        prefix: "phase50/baseline",
      },
    });

    await persistence.persistAndConfirm(artifact);

    assert.equal(client.puts.length, 1);
    const put = client.puts[0];
    assert.ok(put !== undefined);
    assert.equal(put.ifNoneMatch, "*");
    assert.equal(put.serverSideEncryption, "AES256");
    assert.equal(put.key, `phase50/baseline/${EXECUTION_ID}.json`);
    assert.equal(
      phase50ExampleDeterministicKey("phase50/baseline", EXECUTION_ID),
      put.key,
    );
  });
});

class RecordingS3Client implements Phase49S3ObjectClient {
  readonly puts: Phase49S3PutInput[] = [];
  readonly #artifact: ReturnType<typeof buildPhase49Artifact>;

  constructor(artifact: ReturnType<typeof buildPhase49Artifact>) {
    this.#artifact = artifact;
  }

  putObject(input: Phase49S3PutInput): Promise<void> {
    this.puts.push(input);
    return Promise.resolve();
  }

  headObject(_input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation> {
    return Promise.resolve({
      checksumType: this.#artifact.checksumType,
      checksumSha256Base64: this.#artifact.envelopeChecksumSha256Base64,
      metadata: this.#artifact.metadata,
      serverSideEncryption: PHASE49_S3_SERVER_SIDE_ENCRYPTION,
      contentLength: this.#artifact.sizeBytes,
    });
  }

  getObject(_input: Phase49S3GetInput): Promise<Phase49S3GetObservation> {
    return Promise.reject(new Error("getObject is not used by this persistence probe"));
  }
}

function loadGolden(): Phase50GoldenContract {
  const raw: unknown = JSON.parse(
    readFileSync(resolve("docs/contracts/phase50-contract-baseline.json"), "utf8"),
  ) as unknown;
  return parsePhase50GoldenContract(raw);
}

function loadExpectedFailures() {
  const raw: unknown = JSON.parse(
    readFileSync(resolve("docs/verification/phase50-expected-failures.json"), "utf8"),
  ) as unknown;
  return parsePhase50ExpectedFailureRegistry(raw);
}
