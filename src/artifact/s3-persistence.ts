import {
  PHASE49_ARTIFACT_FORMAT_VERSION,
  PHASE49_S3_CHECKSUM_ALGORITHM,
  PHASE49_S3_CHECKSUM_TYPE,
  verifyPhase49ArtifactBody,
  verifyPhase49ArtifactHead,
  type Phase49ArtifactEnvelopeDocument,
  type Phase49ArtifactMetadata,
  type Phase49BuiltArtifact,
} from "./contract.js";

export const PHASE49_S3_SERVER_SIDE_ENCRYPTION = "AES256" as const;
export const PHASE49_DEFAULT_S3_PREFIX = "phase49/artifacts" as const;
export const PHASE49_MIN_RETENTION_DAYS = 30 as const;

export interface Phase49S3RuntimeConfig {
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly expectedBucketOwner?: string;
}

export interface Phase49S3PutInput {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly metadata: Phase49ArtifactMetadata;
  readonly checksumAlgorithm: typeof PHASE49_S3_CHECKSUM_ALGORITHM;
  readonly checksumSha256Base64: string;
  readonly ifNoneMatch: "*";
  readonly serverSideEncryption: typeof PHASE49_S3_SERVER_SIDE_ENCRYPTION;
  readonly expectedBucketOwner?: string;
}

export interface Phase49S3HeadInput {
  readonly bucket: string;
  readonly key: string;
  readonly checksumMode: "ENABLED";
  readonly expectedBucketOwner?: string;
}

export interface Phase49S3GetInput {
  readonly bucket: string;
  readonly key: string;
  readonly checksumMode: "ENABLED";
  readonly expectedBucketOwner?: string;
}

export interface Phase49S3ObjectObservation {
  readonly checksumType?: string | null;
  readonly checksumSha256Base64?: string | null;
  readonly metadata?: Readonly<Record<string, string | undefined>> | null;
  readonly serverSideEncryption?: string | null;
  readonly versionId?: string | null;
  readonly contentLength?: number | null;
}

export interface Phase49S3GetObservation extends Phase49S3ObjectObservation {
  readonly body: Uint8Array;
}

export interface Phase49S3ObjectClient {
  putObject(input: Phase49S3PutInput): Promise<void>;
  headObject(input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation>;
  getObject(input: Phase49S3GetInput): Promise<Phase49S3GetObservation>;
}

export type Phase49S3OperationFailureKind =
  | "conflict"
  | "not_found"
  | "access_denied"
  | "ambiguous"
  | "definitive";

export class Phase49S3OperationError extends Error {
  readonly kind: Phase49S3OperationFailureKind;

  constructor(
    kind: Phase49S3OperationFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "Phase49S3OperationError";
    this.kind = kind;
  }
}

export interface Phase49PersistedArtifact {
  readonly bucket: string;
  readonly key: string;
  readonly artifactReference: string;
  readonly adoptedExistingObject: boolean;
}

export function loadPhase49S3RuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): Phase49S3RuntimeConfig {
  const region = requiredEnv(env, "AGENT_RUNNER_ARTIFACT_S3_REGION");
  const bucket = requiredEnv(env, "AGENT_RUNNER_ARTIFACT_S3_BUCKET");
  const prefix = normalizePrefix(env.AGENT_RUNNER_ARTIFACT_S3_PREFIX ?? PHASE49_DEFAULT_S3_PREFIX);
  const ownerRaw = env.AGENT_RUNNER_ARTIFACT_S3_EXPECTED_BUCKET_OWNER?.trim();

  if (!isValidBucketName(bucket)) {
    throw new Error("AGENT_RUNNER_ARTIFACT_S3_BUCKET must be a DNS-compatible S3 bucket name");
  }
  if (ownerRaw !== undefined && ownerRaw !== "" && !/^\d{12}$/u.test(ownerRaw)) {
    throw new Error("AGENT_RUNNER_ARTIFACT_S3_EXPECTED_BUCKET_OWNER must be a 12-digit AWS account ID");
  }

  return Object.freeze({
    region,
    bucket,
    prefix,
    ...(ownerRaw === undefined || ownerRaw === "" ? {} : { expectedBucketOwner: ownerRaw }),
  });
}

export function phase49ArtifactObjectKey(
  config: Phase49S3RuntimeConfig,
  executionId: string,
): string {
  if (!isLowercaseUuidV4(executionId)) {
    throw new Error("Phase 49 artifact execution_id must be a lowercase UUIDv4");
  }
  return `${config.prefix}/${executionId}.json`;
}

export function formatPhase49ArtifactReference(bucket: string, key: string): string {
  if (!isValidBucketName(bucket)) {
    throw new Error("Phase 49 artifact reference bucket is invalid");
  }
  if (key === "" || key.startsWith("/") || key.includes("\0")) {
    throw new Error("Phase 49 artifact reference key is invalid");
  }
  return `s3://${bucket}/${key}`;
}

export function parsePhase49ArtifactReference(reference: string): {
  readonly bucket: string;
  readonly key: string;
} {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw new Error("Phase 49 artifact_reference is not a valid URI");
  }
  if (
    url.protocol !== "s3:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Phase 49 artifact_reference must use canonical s3://bucket/key form");
  }
  const bucket = url.hostname;
  const key = url.pathname.replace(/^\//u, "");
  if (!isValidBucketName(bucket) || key === "" || key.includes("\0")) {
    throw new Error("Phase 49 artifact_reference is invalid");
  }
  return Object.freeze({ bucket, key });
}

export class Phase49S3ArtifactPersistence {
  readonly #client: Phase49S3ObjectClient;
  readonly #config: Phase49S3RuntimeConfig;

  constructor(input: {
    readonly client: Phase49S3ObjectClient;
    readonly config: Phase49S3RuntimeConfig;
  }) {
    this.#client = input.client;
    this.#config = input.config;
  }

  async persistAndConfirm(artifact: Phase49BuiltArtifact): Promise<Phase49PersistedArtifact> {
    assertArtifactCompatible(artifact);
    const key = phase49ArtifactObjectKey(this.#config, artifact.manifest.executionId);
    let adoptedExistingObject = false;

    try {
      await this.#client.putObject({
        bucket: this.#config.bucket,
        key,
        body: artifact.body,
        metadata: artifact.metadata,
        checksumAlgorithm: PHASE49_S3_CHECKSUM_ALGORITHM,
        checksumSha256Base64: artifact.envelopeChecksumSha256Base64,
        ifNoneMatch: "*",
        serverSideEncryption: PHASE49_S3_SERVER_SIDE_ENCRYPTION,
        ...ownerOption(this.#config),
      });
    } catch (error) {
      if (!isRecoverablePersistenceError(error)) {
        throw error;
      }
      adoptedExistingObject = true;
    }

    await this.#confirmByHead(artifact, key);
    return Object.freeze({
      bucket: this.#config.bucket,
      key,
      artifactReference: formatPhase49ArtifactReference(this.#config.bucket, key),
      adoptedExistingObject,
    });
  }

  async getAndVerify(
    artifactReference: string,
    expected: Phase49BuiltArtifact,
  ): Promise<Phase49ArtifactEnvelopeDocument> {
    const parsed = parsePhase49ArtifactReference(artifactReference);
    const expectedKey = phase49ArtifactObjectKey(this.#config, expected.manifest.executionId);
    if (parsed.bucket !== this.#config.bucket || parsed.key !== expectedKey) {
      throw new Error("Phase 49 artifact_reference does not match configured deterministic address");
    }

    const observed = await this.#client.getObject({
      bucket: parsed.bucket,
      key: parsed.key,
      checksumMode: "ENABLED",
      ...ownerOption(this.#config),
    });
    assertS3StorageObservation(expected, observed);
    return verifyPhase49ArtifactBody(observed.body, expected);
  }

  async #confirmByHead(artifact: Phase49BuiltArtifact, key: string): Promise<void> {
    const observed = await this.#client.headObject({
      bucket: this.#config.bucket,
      key,
      checksumMode: "ENABLED",
      ...ownerOption(this.#config),
    });
    assertS3StorageObservation(artifact, observed);
  }
}

function assertS3StorageObservation(
  expected: Phase49BuiltArtifact,
  observed: Phase49S3ObjectObservation,
): void {
  if (observed.serverSideEncryption !== PHASE49_S3_SERVER_SIDE_ENCRYPTION) {
    throw new Error("Phase 49 artifact is not confirmed with SSE-S3 AES256");
  }
  if (observed.versionId !== undefined && observed.versionId !== null) {
    throw new Error("Phase 49 artifact bucket versioning baseline is not disabled");
  }
  if (
    observed.contentLength !== undefined &&
    observed.contentLength !== null &&
    observed.contentLength !== expected.sizeBytes
  ) {
    throw new Error("Phase 49 artifact content length mismatch");
  }

  verifyPhase49ArtifactHead(expected, {
    checksumModeEnabled: true,
    checksumType: observed.checksumType,
    checksumSha256Base64: observed.checksumSha256Base64,
    metadata: observed.metadata,
  });
}

function assertArtifactCompatible(artifact: Phase49BuiltArtifact): void {
  if (artifact.manifest.artifactFormatVersion !== PHASE49_ARTIFACT_FORMAT_VERSION) {
    throw new Error("Phase 49 S3 persistence received an unsupported artifact format");
  }
  if (
    artifact.checksumAlgorithm !== PHASE49_S3_CHECKSUM_ALGORITHM ||
    artifact.checksumType !== PHASE49_S3_CHECKSUM_TYPE
  ) {
    throw new Error("Phase 49 S3 persistence requires SHA256 FULL_OBJECT checksum contract");
  }
}

function ownerOption(
  config: Phase49S3RuntimeConfig,
): { readonly expectedBucketOwner?: string } {
  return config.expectedBucketOwner === undefined
    ? {}
    : { expectedBucketOwner: config.expectedBucketOwner };
}

function isRecoverablePersistenceError(error: unknown): boolean {
  return error instanceof Phase49S3OperationError &&
    (error.kind === "conflict" || error.kind === "ambiguous");
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function normalizePrefix(raw: string): string {
  const value = raw.trim().replace(/^\/+|\/+$/gu, "");
  if (
    value === "" ||
    value.length > 256 ||
    value.includes("..") ||
    !/^[a-z0-9][a-z0-9/_-]*$/u.test(value)
  ) {
    throw new Error("AGENT_RUNNER_ARTIFACT_S3_PREFIX must be a bounded lowercase ASCII S3 key prefix");
  }
  return value;
}

function isLowercaseUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isValidBucketName(value: string): boolean {
  return value.length >= 3 &&
    value.length <= 63 &&
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value) &&
    !value.includes("..") &&
    !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value);
}
