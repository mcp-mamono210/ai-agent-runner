import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandInput,
  type GetObjectCommandOutput,
  type HeadObjectCommandInput,
  type HeadObjectCommandOutput,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";

import {
  Phase49S3OperationError,
  type Phase49S3GetInput,
  type Phase49S3GetObservation,
  type Phase49S3HeadInput,
  type Phase49S3ObjectClient,
  type Phase49S3ObjectObservation,
  type Phase49S3PutInput,
  type Phase49S3RuntimeConfig,
} from "./s3-persistence.js";

export class AwsSdkPhase49S3ObjectClient implements Phase49S3ObjectClient {
  readonly #client: S3Client;

  constructor(input: {
    readonly config: Pick<Phase49S3RuntimeConfig, "region">;
    readonly client?: S3Client;
  }) {
    this.#client = input.client ?? new S3Client({ region: input.config.region });
  }

  async putObject(input: Phase49S3PutInput): Promise<void> {
    try {
      await this.#client.send(new PutObjectCommand(buildAwsPhase49PutObjectInput(input)));
    } catch (error) {
      throw mapAwsS3Error(error, "put");
    }
  }

  async headObject(input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation> {
    let output: HeadObjectCommandOutput;
    try {
      output = await this.#client.send(new HeadObjectCommand(buildAwsPhase49HeadObjectInput(input)));
    } catch (error) {
      throw mapAwsS3Error(error, "head");
    }
    return observationFromOutput(output);
  }

  async getObject(input: Phase49S3GetInput): Promise<Phase49S3GetObservation> {
    let output: GetObjectCommandOutput;
    try {
      output = await this.#client.send(new GetObjectCommand(buildAwsPhase49GetObjectInput(input)));
    } catch (error) {
      throw mapAwsS3Error(error, "get");
    }

    return Object.freeze({
      ...observationFromOutput(output),
      body: await readBody(output.Body),
    });
  }
}

export function buildAwsPhase49PutObjectInput(input: Phase49S3PutInput): PutObjectCommandInput {
  return {
    Bucket: input.bucket,
    Key: input.key,
    Body: input.body,
    Metadata: { ...input.metadata },
    ChecksumAlgorithm: input.checksumAlgorithm,
    ChecksumSHA256: input.checksumSha256Base64,
    IfNoneMatch: input.ifNoneMatch,
    ServerSideEncryption: input.serverSideEncryption,
    ContentType: "application/vnd.mcp.phase49-artifact+json",
    ...(input.expectedBucketOwner === undefined
      ? {}
      : { ExpectedBucketOwner: input.expectedBucketOwner }),
  };
}

export function buildAwsPhase49HeadObjectInput(input: Phase49S3HeadInput): HeadObjectCommandInput {
  return {
    Bucket: input.bucket,
    Key: input.key,
    ChecksumMode: input.checksumMode,
    ...(input.expectedBucketOwner === undefined
      ? {}
      : { ExpectedBucketOwner: input.expectedBucketOwner }),
  };
}

export function buildAwsPhase49GetObjectInput(input: Phase49S3GetInput): GetObjectCommandInput {
  return {
    Bucket: input.bucket,
    Key: input.key,
    ChecksumMode: input.checksumMode,
    ...(input.expectedBucketOwner === undefined
      ? {}
      : { ExpectedBucketOwner: input.expectedBucketOwner }),
  };
}

function observationFromOutput(
  output: Pick<
    HeadObjectCommandOutput,
    | "ChecksumType"
    | "ChecksumSHA256"
    | "Metadata"
    | "ServerSideEncryption"
    | "VersionId"
    | "ContentLength"
  >,
): Phase49S3ObjectObservation {
  return Object.freeze({
    checksumType: output.ChecksumType,
    checksumSha256Base64: output.ChecksumSHA256,
    metadata: output.Metadata,
    serverSideEncryption: output.ServerSideEncryption,
    versionId: output.VersionId,
    contentLength: output.ContentLength,
  });
}

interface TransformableBody {
  transformToByteArray(): Promise<Uint8Array>;
}

async function readBody(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  if (isTransformableBody(body)) {
    return await body.transformToByteArray();
  }
  throw new Phase49S3OperationError(
    "definitive",
    "S3 GetObject did not return a supported body representation",
  );
}

function isTransformableBody(value: unknown): value is TransformableBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { readonly transformToByteArray?: unknown };
  return typeof candidate.transformToByteArray === "function";
}

function mapAwsS3Error(
  error: unknown,
  operation: "put" | "head" | "get",
): Phase49S3OperationError {
  const status = awsHttpStatus(error);
  const name = awsErrorName(error);

  if (operation === "put" && (status === 409 || status === 412 || name === "PreconditionFailed" || name === "ConditionalRequestConflict")) {
    return new Phase49S3OperationError(
      "conflict",
      "S3 conditional PutObject found an existing or conflicting object",
      { cause: error },
    );
  }
  if ((operation === "head" || operation === "get") && (status === 404 || name === "NoSuchKey" || name === "NotFound")) {
    return new Phase49S3OperationError(
      "not_found",
      "S3 artifact object was not found",
      { cause: error },
    );
  }
  if (status === 403 || name === "AccessDenied") {
    return new Phase49S3OperationError(
      "access_denied",
      "S3 artifact operation was denied",
      { cause: error },
    );
  }
  if (
    status === undefined ||
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    name === "RequestTimeout" ||
    name === "SlowDown"
  ) {
    return new Phase49S3OperationError(
      "ambiguous",
      "S3 artifact operation failed without a definitive durable-state result",
      { cause: error },
    );
  }
  return new Phase49S3OperationError(
    "definitive",
    `S3 artifact operation failed definitively${status === undefined ? "" : ` with HTTP ${status}`}`,
    { cause: error },
  );
}

function awsHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const metadata = (error as { readonly $metadata?: unknown }).$metadata;
  if (typeof metadata !== "object" || metadata === null) {
    return undefined;
  }
  const status = (metadata as { readonly httpStatusCode?: unknown }).httpStatusCode;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function awsErrorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const name = (error as { readonly name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}
