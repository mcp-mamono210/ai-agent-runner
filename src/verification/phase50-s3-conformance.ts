import { createHash, randomUUID } from "node:crypto";

import { buildPhase49Artifact } from "../artifact/contract.js";
import {
  Phase49S3OperationError,
  type Phase49S3ObjectClient,
  type Phase49S3RuntimeConfig,
} from "../artifact/s3-persistence.js";
import type { Phase50ConformanceFinding } from "./phase50-conformance.js";

const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

export interface Phase50S3ConformanceInput {
  readonly client: Phase49S3ObjectClient;
  readonly config: Phase49S3RuntimeConfig;
  readonly executionId: string;
  readonly issueId: number;
  readonly repository: string;
  readonly sourceRevision: string;
}

export async function runPhase50S3Conformance(
  input: Phase50S3ConformanceInput,
): Promise<readonly Phase50ConformanceFinding[]> {
  const artifact = buildPhase49Artifact({
    executionId: input.executionId,
    issueId: input.issueId,
    repository: input.repository,
    sourceRevision: input.sourceRevision,
    briefRevision: 1,
    persistedRevision: `phase50-s3:${input.sourceRevision}`,
    requirementsFingerprint: `sha256:${createHash("sha256").update(input.sourceRevision).digest("hex")}`,
    outcome: "changes_ready",
    changedFiles: [{ path: "a.txt", status: "modified" }],
    patch: {
      text: PATCH,
      capturedBytes: Buffer.byteLength(PATCH, "utf8"),
      truncated: false,
    },
  });

  const basePrefix = input.config.prefix.replace(/\/+$/u, "");
  const runPrefix = `${basePrefix}/runs/${randomUUID()}`;
  const key = `${runPrefix}/${input.executionId}.json`;
  const putInput = Object.freeze({
    bucket: input.config.bucket,
    key,
    body: artifact.body,
    metadata: artifact.metadata,
    checksumAlgorithm: artifact.checksumAlgorithm,
    checksumSha256Base64: artifact.envelopeChecksumSha256Base64,
    ifNoneMatch: "*" as const,
    serverSideEncryption: "AES256" as const,
    ...(input.config.expectedBucketOwner === undefined
      ? {}
      : { expectedBucketOwner: input.config.expectedBucketOwner }),
  });

  await input.client.putObject(putInput);

  let conditionalConflict = false;
  try {
    await input.client.putObject(putInput);
  } catch (error) {
    if (error instanceof Phase49S3OperationError && error.kind === "conflict") {
      conditionalConflict = true;
    } else {
      throw error;
    }
  }

  const ownerOption = input.config.expectedBucketOwner === undefined
    ? {}
    : { expectedBucketOwner: input.config.expectedBucketOwner };
  const head = await input.client.headObject({
    bucket: input.config.bucket,
    key,
    checksumMode: "ENABLED",
    ...ownerOption,
  });
  const get = await input.client.getObject({
    bucket: input.config.bucket,
    key,
    checksumMode: "ENABLED",
    ...ownerOption,
  });

  const expectedMetadataKeys = Object.keys(artifact.metadata).sort();
  const observedMetadataKeys = Object.keys(head.metadata ?? {}).sort();
  const metadataKeysLowerKebab = observedMetadataKeys.every(
    (keyValue) => keyValue === keyValue.toLowerCase() && !keyValue.includes("_"),
  );
  const metadataRoundTrip =
    arraysEqual(expectedMetadataKeys, observedMetadataKeys) &&
    expectedMetadataKeys.every((keyValue) => head.metadata?.[keyValue] === artifact.metadata[keyValue as keyof typeof artifact.metadata]);
  const bodyRoundTrip = Buffer.compare(Buffer.from(get.body), Buffer.from(artifact.body)) === 0;

  return Object.freeze([
    compatibleFinding(
      "s3.if-none-match",
      "If-None-Match:* rejects an existing deterministic object",
      conditionalConflict,
      conditionalConflict ? "second conditional PutObject returned conflict" : "second conditional PutObject did not return conflict",
    ),
    compatibleFinding(
      "s3.full-object-checksum",
      "SHA-256 FULL_OBJECT checksum is returned and equals the uploaded artifact checksum",
      head.checksumType === "FULL_OBJECT" && head.checksumSha256Base64 === artifact.envelopeChecksumSha256Base64,
      `Head checksumType=${String(head.checksumType)} checksumMatch=${String(head.checksumSha256Base64 === artifact.envelopeChecksumSha256Base64)}`,
    ),
    compatibleFinding(
      "s3.head-checksum-mode",
      "HeadObject ChecksumMode=ENABLED exposes ChecksumSHA256",
      typeof head.checksumSha256Base64 === "string" && head.checksumSha256Base64 !== "",
      `Head ChecksumSHA256 present=${String(typeof head.checksumSha256Base64 === "string" && head.checksumSha256Base64 !== "")}`,
    ),
    compatibleFinding(
      "s3.get-checksum-mode",
      "GetObject ChecksumMode=ENABLED exposes ChecksumSHA256 and exact body",
      get.checksumSha256Base64 === artifact.envelopeChecksumSha256Base64 && bodyRoundTrip,
      `Get checksumMatch=${String(get.checksumSha256Base64 === artifact.envelopeChecksumSha256Base64)} bodyRoundTrip=${String(bodyRoundTrip)}`,
    ),
    compatibleFinding(
      "s3.metadata-normalization",
      "required metadata keys are lowercase kebab-case",
      metadataKeysLowerKebab,
      `observed metadata keys=${observedMetadataKeys.join(",")}`,
    ),
    compatibleFinding(
      "s3.metadata-round-trip",
      "required metadata fields round-trip with exact logical values",
      metadataRoundTrip,
      `metadataRoundTrip=${String(metadataRoundTrip)}`,
    ),
    compatibleFinding(
      "s3.sse-s3",
      "SSE-S3 AES256 is observed on the stored object",
      head.serverSideEncryption === "AES256",
      `serverSideEncryption=${String(head.serverSideEncryption)}`,
    ),
  ]);
}

function compatibleFinding(
  id: string,
  requirement: string,
  compatible: boolean,
  evidence: string,
): Phase50ConformanceFinding {
  if (compatible) {
    return Object.freeze({
      id,
      surface: "s3",
      requirement,
      classification: "compatible",
      evidence: Object.freeze([evidence]),
    });
  }
  return Object.freeze({
    id,
    surface: "s3",
    requirement,
    classification: "incompatible",
    evidence: Object.freeze([evidence]),
    coverageRoute: "C",
    coverageExecuted: false,
    coverageEvidence: Object.freeze(["real infrastructure verification is required before Phase 50 coverage closure"]),
  });
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
