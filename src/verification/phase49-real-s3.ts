import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { AwsSdkPhase49S3ObjectClient } from "../artifact/aws-s3-client.js";
import {
  PHASE49_ARTIFACT_FORMAT_VERSION,
  PHASE49_MAX_ARTIFACT_BYTES,
  PHASE49_REQUIRED_METADATA_KEYS,
  buildPhase49Artifact,
  type Phase49BuiltArtifact,
} from "../artifact/contract.js";
import {
  PHASE49_MIN_RETENTION_DAYS,
  PHASE49_S3_SERVER_SIDE_ENCRYPTION,
  Phase49S3ArtifactPersistence,
  Phase49S3OperationError,
  loadPhase49S3RuntimeConfig,
  type Phase49ArtifactIdentity,
  type Phase49S3GetInput,
  type Phase49S3GetObservation,
  type Phase49S3HeadInput,
  type Phase49S3ObjectClient,
  type Phase49S3ObjectObservation,
  type Phase49S3PutInput,
  type Phase49S3RuntimeConfig,
} from "../artifact/s3-persistence.js";

const CHANGES_PATCH =
  "diff --git a/phase49-verification.txt b/phase49-verification.txt\n" +
  "new file mode 100644\n--- /dev/null\n+++ b/phase49-verification.txt\n" +
  "@@ -0,0 +1 @@\n+phase49 real s3 verification\n";

export interface Phase49RealS3VerificationRecord {
  readonly verificationDate: string;
  readonly testedGitRevision: string;
  readonly artifactContractRevision: typeof PHASE49_ARTIFACT_FORMAT_VERSION;
  readonly awsRegion: string;
  readonly bucket: string;
  readonly testPrefix: string;
  readonly artifactFormat: typeof PHASE49_ARTIFACT_FORMAT_VERSION;
  readonly maximumArtifactSizeBytes: number;
  readonly uploadMode: "direct PutObject";
  readonly checksum: "SHA-256 FULL_OBJECT";
  readonly checksumMode: "ENABLED";
  readonly metadataProjection: {
    readonly keys: readonly string[];
    readonly keyFormat: "lowercase kebab-case";
    readonly valueEncoding: "ASCII-safe";
    readonly measuredBytes: number;
  };
  readonly readBackStrategy: readonly ["HeadObject", "GetObject"];
  readonly conditionalWrite: "If-None-Match:*";
  readonly encryption: typeof PHASE49_S3_SERVER_SIDE_ENCRYPTION;
  readonly bucketKey: "not applicable for SSE-S3";
  readonly retentionDays: number;
  readonly iamBoundaryAttested: true;
  readonly expectedControllerActions: readonly ["s3:PutObject", "s3:GetObject"];
  readonly excludedControllerActions: readonly ["s3:DeleteObject", "s3:ListBucket"];
  readonly verifiedScenarios: readonly string[];
  readonly artifactReferences: readonly string[];
  readonly result: "PASS";
}

export async function runPhase49RealS3Verification(input: {
  readonly config: Phase49S3RuntimeConfig;
  readonly client: Phase49S3ObjectClient;
  readonly testedGitRevision: string;
  readonly repository: string;
  readonly issueId: number;
  readonly retentionDays: number;
  readonly iamBoundaryAttested: boolean;
  readonly now?: () => Date;
}): Promise<Phase49RealS3VerificationRecord> {
  assertVerificationInput(input);
  const client = new RecordingS3Client(input.client);
  const persistence = new Phase49S3ArtifactPersistence({ client, config: input.config });

  const changes = artifactFixture({
    executionId: randomUUID(),
    issueId: input.issueId,
    repository: input.repository,
    sourceRevision: input.testedGitRevision,
    outcome: "changes_ready",
  });
  const changesPersisted = await persistence.persistAndConfirm(changes);
  await persistence.getAndVerify(changesPersisted.artifactReference, changes);
  const recoveredChanges = await persistence.recoverAndVerify(identityFrom(changes));
  if (recoveredChanges.artifact.envelopeChecksumSha256Hex !== changes.envelopeChecksumSha256Hex) {
    throw new Error("Phase 49 real S3 recovered checksum mismatch");
  }

  let incompatibleRejected = false;
  const incompatible = artifactFixture({
    executionId: changes.manifest.executionId,
    issueId: input.issueId,
    repository: input.repository,
    sourceRevision: input.testedGitRevision,
    outcome: "changes_ready",
    patchSuffix: "incompatible",
  });
  try {
    await persistence.persistAndConfirm(incompatible);
  } catch {
    incompatibleRejected = true;
  }
  if (!incompatibleRejected) {
    throw new Error("Phase 49 real S3 incompatible second PutObject was not rejected");
  }

  const noChanges = artifactFixture({
    executionId: randomUUID(),
    issueId: input.issueId,
    repository: input.repository,
    sourceRevision: input.testedGitRevision,
    outcome: "no_changes",
  });
  const noChangesPersisted = await persistence.persistAndConfirm(noChanges);
  await persistence.getAndVerify(noChangesPersisted.artifactReference, noChanges);
  await persistence.recoverAndVerify(identityFrom(noChanges));

  const ambiguousArtifact = artifactFixture({
    executionId: randomUUID(),
    issueId: input.issueId,
    repository: input.repository,
    sourceRevision: input.testedGitRevision,
    outcome: "changes_ready",
    patchSuffix: "ambiguous",
  });
  const ambiguousPersistence = new Phase49S3ArtifactPersistence({
    client: new AmbiguousAfterSuccessfulPutClient(client),
    config: input.config,
  });
  const ambiguousPersisted = await ambiguousPersistence.persistAndConfirm(ambiguousArtifact);
  if (!ambiguousPersisted.adoptedExistingObject) {
    throw new Error("Phase 49 real S3 ambiguous write was not adopted after Head verification");
  }

  assertRecordedAwsSemantics(client, changes);
  const verificationDate = (input.now ?? (() => new Date()))().toISOString();
  const references = Object.freeze([
    changesPersisted.artifactReference,
    noChangesPersisted.artifactReference,
    ambiguousPersisted.artifactReference,
  ]);

  return Object.freeze({
    verificationDate,
    testedGitRevision: input.testedGitRevision,
    artifactContractRevision: PHASE49_ARTIFACT_FORMAT_VERSION,
    awsRegion: input.config.region,
    bucket: input.config.bucket,
    testPrefix: input.config.prefix,
    artifactFormat: PHASE49_ARTIFACT_FORMAT_VERSION,
    maximumArtifactSizeBytes: PHASE49_MAX_ARTIFACT_BYTES,
    uploadMode: "direct PutObject",
    checksum: "SHA-256 FULL_OBJECT",
    checksumMode: "ENABLED",
    metadataProjection: Object.freeze({
      keys: Object.freeze([...PHASE49_REQUIRED_METADATA_KEYS]),
      keyFormat: "lowercase kebab-case",
      valueEncoding: "ASCII-safe",
      measuredBytes: changes.metadataBytes,
    }),
    readBackStrategy: Object.freeze(["HeadObject", "GetObject"] as const),
    conditionalWrite: "If-None-Match:*",
    encryption: PHASE49_S3_SERVER_SIDE_ENCRYPTION,
    bucketKey: "not applicable for SSE-S3",
    retentionDays: input.retentionDays,
    iamBoundaryAttested: true,
    expectedControllerActions: Object.freeze(["s3:PutObject", "s3:GetObject"] as const),
    excludedControllerActions: Object.freeze(["s3:DeleteObject", "s3:ListBucket"] as const),
    verifiedScenarios: Object.freeze([
      "changes_ready direct conditional PutObject + HeadObject + GetObject",
      "no_changes durable empty artifact",
      "deterministic recovery without workspace or ListBucket",
      "required metadata and SHA-256 checksum read-back",
      "lowercase kebab-case metadata projection",
      "incompatible second conditional PutObject rejected",
      "ambiguous remote-success recovery adopts matching object",
      "SSE-S3 AES256 and disabled-versioning observation",
    ]),
    artifactReferences: references,
    result: "PASS",
  });
}

export async function runPhase49RealS3VerificationFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Phase49RealS3VerificationRecord> {
  const config = loadPhase49S3RuntimeConfig(env);
  const recordPath = requiredEnv(env, "PHASE49_REAL_S3_VERIFICATION_RECORD");
  const record = await runPhase49RealS3Verification({
    config,
    client: new AwsSdkPhase49S3ObjectClient({ config }),
    testedGitRevision: requiredGitRevision(env.PHASE49_REAL_S3_TESTED_GIT_REVISION),
    repository: requiredEnv(env, "PHASE49_REAL_S3_REPOSITORY"),
    issueId: requiredPositiveInteger(env.PHASE49_REAL_S3_ISSUE_ID, "PHASE49_REAL_S3_ISSUE_ID"),
    retentionDays: requiredPositiveInteger(
      env.PHASE49_REAL_S3_RETENTION_DAYS,
      "PHASE49_REAL_S3_RETENTION_DAYS",
    ),
    iamBoundaryAttested: env.PHASE49_REAL_S3_IAM_BOUNDARY_CONFIRMED?.toLowerCase() === "yes",
  });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  return record;
}

class RecordingS3Client implements Phase49S3ObjectClient {
  readonly puts: Phase49S3PutInput[] = [];
  readonly heads: Array<{ input: Phase49S3HeadInput; output: Phase49S3ObjectObservation }> = [];
  readonly gets: Array<{ input: Phase49S3GetInput; output: Phase49S3GetObservation }> = [];
  readonly #inner: Phase49S3ObjectClient;

  constructor(inner: Phase49S3ObjectClient) {
    this.#inner = inner;
  }

  async putObject(input: Phase49S3PutInput): Promise<void> {
    this.puts.push(input);
    await this.#inner.putObject(input);
  }

  async headObject(input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation> {
    const output = await this.#inner.headObject(input);
    this.heads.push({ input, output });
    return output;
  }

  async getObject(input: Phase49S3GetInput): Promise<Phase49S3GetObservation> {
    const output = await this.#inner.getObject(input);
    this.gets.push({ input, output });
    return output;
  }
}

class AmbiguousAfterSuccessfulPutClient implements Phase49S3ObjectClient {
  readonly #inner: Phase49S3ObjectClient;
  #injected = false;

  constructor(inner: Phase49S3ObjectClient) {
    this.#inner = inner;
  }

  async putObject(input: Phase49S3PutInput): Promise<void> {
    await this.#inner.putObject(input);
    if (!this.#injected) {
      this.#injected = true;
      throw new Phase49S3OperationError(
        "ambiguous",
        "Phase 49 verification injected response loss after successful remote PutObject",
      );
    }
  }

  headObject(input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation> {
    return this.#inner.headObject(input);
  }

  getObject(input: Phase49S3GetInput): Promise<Phase49S3GetObservation> {
    return this.#inner.getObject(input);
  }
}

function artifactFixture(input: {
  readonly executionId: string;
  readonly issueId: number;
  readonly repository: string;
  readonly sourceRevision: string;
  readonly outcome: "changes_ready" | "no_changes";
  readonly patchSuffix?: string;
}): Phase49BuiltArtifact {
  const patch = input.outcome === "no_changes"
    ? ""
    : `${CHANGES_PATCH}${input.patchSuffix === undefined ? "" : `# ${input.patchSuffix}\n`}`;
  return buildPhase49Artifact({
    executionId: input.executionId,
    issueId: input.issueId,
    repository: input.repository,
    sourceRevision: input.sourceRevision,
    briefRevision: 1,
    persistedRevision: `phase49-real-s3:${input.sourceRevision}`,
    requirementsFingerprint: `sha256:${createHash("sha256").update(input.sourceRevision).digest("hex")}`,
    outcome: input.outcome,
    changedFiles: input.outcome === "no_changes"
      ? []
      : [{ path: "phase49-verification.txt", status: "added" }],
    patch: {
      text: patch,
      capturedBytes: Buffer.byteLength(patch, "utf8"),
      truncated: false,
    },
  });
}

function identityFrom(artifact: Phase49BuiltArtifact): Phase49ArtifactIdentity {
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

function assertRecordedAwsSemantics(client: RecordingS3Client, artifact: Phase49BuiltArtifact): void {
  if (client.puts.length < 3 || client.heads.length === 0 || client.gets.length === 0) {
    throw new Error("Phase 49 real S3 verification did not exercise required Put/Head/Get operations");
  }
  const put = client.puts[0]!;
  if (
    put.ifNoneMatch !== "*" ||
    put.checksumAlgorithm !== "SHA256" ||
    put.checksumSha256Base64 !== artifact.envelopeChecksumSha256Base64 ||
    put.serverSideEncryption !== "AES256"
  ) {
    throw new Error("Phase 49 real S3 PutObject request contract mismatch");
  }
  if (client.heads.some((entry) => entry.input.checksumMode !== "ENABLED")) {
    throw new Error("Phase 49 real S3 HeadObject omitted ChecksumMode=ENABLED");
  }
  if (client.gets.some((entry) => entry.input.checksumMode !== "ENABLED")) {
    throw new Error("Phase 49 real S3 GetObject omitted ChecksumMode=ENABLED");
  }
  for (const key of PHASE49_REQUIRED_METADATA_KEYS) {
    if (key !== key.toLowerCase() || key.includes("_")) {
      throw new Error("Phase 49 metadata key contract is not lowercase kebab-case");
    }
  }
  if (PHASE49_REQUIRED_METADATA_KEYS.some((key) => key.includes("changed-file"))) {
    throw new Error("Phase 49 changed-file information leaked into metadata projection");
  }
  if (Object.values(artifact.metadata).some((value) => !/^[\x20-\x7e]+$/u.test(value))) {
    throw new Error("Phase 49 metadata projection contains non-ASCII values");
  }
}

function assertVerificationInput(input: {
  readonly testedGitRevision: string;
  readonly repository: string;
  readonly issueId: number;
  readonly retentionDays: number;
  readonly iamBoundaryAttested: boolean;
}): void {
  requiredGitRevision(input.testedGitRevision);
  if (input.repository.trim() === "") {
    throw new Error("Phase 49 real S3 repository must not be blank");
  }
  if (!Number.isSafeInteger(input.issueId) || input.issueId <= 0) {
    throw new Error("Phase 49 real S3 issueId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.retentionDays) || input.retentionDays < PHASE49_MIN_RETENTION_DAYS) {
    throw new Error(`Phase 49 real S3 retention must be at least ${PHASE49_MIN_RETENTION_DAYS} days`);
  }
  if (!input.iamBoundaryAttested) {
    throw new Error("Phase 49 real S3 verification requires IAM boundary attestation");
  }
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredPositiveInteger(raw: string | undefined, name: string): number {
  if (raw === undefined || !/^[1-9]\d*$/u.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function requiredGitRevision(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!/^[0-9a-f]{40,64}$/u.test(value)) {
    throw new Error("PHASE49_REAL_S3_TESTED_GIT_REVISION must be a lowercase full Git revision");
  }
  return value;
}


const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const record = await runPhase49RealS3VerificationFromEnvironment();
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}
