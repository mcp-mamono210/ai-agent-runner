import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { RepositoryCredentialProvider } from "./policy.js";
import { RepositoryAccessPolicy } from "./policy.js";
import {
  RepositoryAccessError,
  type RepositoryCheckout,
  type RepositoryCheckoutInput,
  type RepositoryCheckoutResult,
  type RepositoryCredential,
  type RepositorySourceResolver,
  type ResolvedSource,
} from "./types.js";

const FULL_GIT_OID_PATTERN = /^[0-9a-f]{40,128}$/u;
const DEFAULT_MAX_BUFFER_BYTES = 1_048_576;

export interface GitCommandInput {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly credential?: RepositoryCredential;
}

export interface GitCommandRunner {
  run(input: GitCommandInput): Promise<string>;
}

export class NodeGitCommandRunner implements GitCommandRunner {
  readonly #maxBufferBytes: number;

  constructor(maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES) {
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes <= 0) {
      throw new Error("maxBufferBytes must be a positive safe integer");
    }
    this.#maxBufferBytes = maxBufferBytes;
  }

  async run(input: GitCommandInput): Promise<string> {
    const env = input.credential === undefined
      ? { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      : credentialEnvironment(input.credential);

    return await new Promise<string>((resolvePromise, rejectPromise) => {
      execFile(
        "git",
        [...input.args],
        {
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          env,
          encoding: "utf8",
          maxBuffer: this.#maxBufferBytes,
        },
        (error, stdout) => {
          if (error !== null) {
            rejectPromise(new Error("git repository operation failed"));
            return;
          }
          resolvePromise(stdout);
        },
      );
    });
  }
}

export class GitCliRepositoryComponent
  implements RepositorySourceResolver, RepositoryCheckout
{
  readonly #policy: RepositoryAccessPolicy;
  readonly #credentialProvider: RepositoryCredentialProvider;
  readonly #git: GitCommandRunner;

  constructor(input: {
    readonly policy: RepositoryAccessPolicy;
    readonly credentialProvider: RepositoryCredentialProvider;
    readonly gitRunner?: GitCommandRunner;
  }) {
    this.#policy = input.policy;
    this.#credentialProvider = input.credentialProvider;
    this.#git = input.gitRunner ?? new NodeGitCommandRunner();
  }

  async resolveExactSource(repository: string): Promise<ResolvedSource> {
    // The authorization decision is intentionally completed before the
    // credential provider is consulted.
    const entry = this.#policy.authorize(repository);
    const credential = this.#credentialProvider.getCredential(entry);
    const temporaryRepository = await mkdtemp(join(tmpdir(), "agent-runner-source-"));

    try {
      await this.#git.run({ args: ["init", "--bare", "."], cwd: temporaryRepository });
      await this.#git.run({
        args: [
          "fetch",
          "--quiet",
          "--depth=1",
          "--no-tags",
          entry.remoteUrl,
          entry.sourceRef,
        ],
        cwd: temporaryRepository,
        credential,
      });
      const sourceRevision = normalizeGitOid(
        await this.#git.run({
          args: ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
          cwd: temporaryRepository,
        }),
      );
      return { repository, sourceRevision };
    } catch (error) {
      if (error instanceof RepositoryAccessError) {
        throw error;
      }
      throw new RepositoryAccessError(
        "source_resolution_failed",
        "exact source revision could not be established",
      );
    } finally {
      await rm(temporaryRepository, { recursive: true, force: true });
    }
  }

  async checkout(input: RepositoryCheckoutInput): Promise<RepositoryCheckoutResult> {
    assertExactGitOid(input.sourceRevision);
    const targetDir = await requireCallerOwnedEmptyDirectory(input.targetDir);

    // Checkout is still credentialed repository access, so authorization is
    // re-established before the credential is consulted. The already-fixed
    // source revision is never replaced with sourceRef here.
    const entry = this.#policy.authorize(input.repository);
    const credential = this.#credentialProvider.getCredential(entry);

    try {
      await this.#git.run({ args: ["init", "."], cwd: targetDir });
      await this.#git.run({
        args: [
          "fetch",
          "--quiet",
          "--depth=1",
          "--no-tags",
          entry.remoteUrl,
          input.sourceRevision,
        ],
        cwd: targetDir,
        credential,
      });
      await this.#git.run({
        args: ["checkout", "--quiet", "--detach", input.sourceRevision],
        cwd: targetDir,
      });
      const headRevision = normalizeGitOid(
        await this.#git.run({
          args: ["rev-parse", "--verify", "HEAD"],
          cwd: targetDir,
        }),
      );
      if (headRevision !== input.sourceRevision) {
        throw new RepositoryAccessError(
          "checkout_failed",
          "checked out HEAD does not match the fixed source revision",
        );
      }
      return {
        repository: input.repository,
        sourceRevision: input.sourceRevision,
        targetDir,
        headRevision,
      };
    } catch (error) {
      if (error instanceof RepositoryAccessError) {
        throw error;
      }
      throw new RepositoryAccessError(
        "checkout_failed",
        "fixed source revision checkout failed",
      );
    }
  }
}

function credentialEnvironment(credential: RepositoryCredential): NodeJS.ProcessEnv {
  const encoded = Buffer.from(
    `${credential.username}:${credential.password}`,
    "utf8",
  ).toString("base64");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${encoded}`,
  };
}

function normalizeGitOid(output: string): string {
  const oid = output.trim();
  assertExactGitOid(oid);
  return oid;
}

function assertExactGitOid(value: string): void {
  if (!FULL_GIT_OID_PATTERN.test(value)) {
    throw new RepositoryAccessError(
      "source_resolution_failed",
      "source revision is not a full lowercase Git object ID",
    );
  }
}

async function requireCallerOwnedEmptyDirectory(targetDir: string): Promise<string> {
  if (!isAbsolute(targetDir)) {
    throw new RepositoryAccessError(
      "checkout_failed",
      "checkout target_dir must be an absolute caller-owned directory",
    );
  }
  const normalized = resolve(targetDir);
  let metadata;
  try {
    metadata = await stat(normalized);
  } catch {
    throw new RepositoryAccessError(
      "checkout_failed",
      "checkout target_dir must already exist",
    );
  }
  if (!metadata.isDirectory()) {
    throw new RepositoryAccessError(
      "checkout_failed",
      "checkout target_dir must be a directory",
    );
  }
  const entries = await readdir(normalized);
  if (entries.length !== 0) {
    throw new RepositoryAccessError(
      "checkout_failed",
      "checkout target_dir must be empty",
    );
  }
  return normalized;
}
