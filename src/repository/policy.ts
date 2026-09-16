import {
  RepositoryAccessError,
  type RepositoryAccessEntry,
  type RepositoryAuthorizationConfiguration,
  type RepositoryCredential,
} from "./types.js";

type Environment = Readonly<Record<string, string | undefined>>;

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const ASCII_EDGE_WHITESPACE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu;

/**
 * Configuration format:
 * repository|remote_url|source_ref|username_env|password_env
 *
 * Multiple entries are separated with semicolons. An explicitly configured
 * empty string is a valid empty allowlist. Missing configuration is invalid.
 */
export function parseRepositoryAccessEntries(
  raw: string | undefined,
): readonly RepositoryAccessEntry[] {
  if (raw === undefined) {
    throw new RepositoryAccessError(
      "authorization_configuration_invalid",
      "repository authorization configuration is unavailable",
    );
  }
  if (raw === "") {
    return [];
  }

  const entries = raw.split(";").map((record, index) => {
    const parts = record.split("|");
    if (parts.length !== 5) {
      throw invalidConfig(`repository configuration entry ${index + 1} is malformed`);
    }

    const repository = trimAsciiEdgeWhitespace(parts[0] ?? "");
    const remoteUrl = (parts[1] ?? "").trim();
    const sourceRef = (parts[2] ?? "").trim();
    const usernameEnv = (parts[3] ?? "").trim();
    const passwordEnv = (parts[4] ?? "").trim();

    if (repository === "") {
      throw invalidConfig(`repository configuration entry ${index + 1} has an empty identity`);
    }
    validateRemoteUrl(remoteUrl, index);
    validateSourceRef(sourceRef, index);
    validateCredentialEnvName(usernameEnv, index, "username");
    validateCredentialEnvName(passwordEnv, index, "password");

    return Object.freeze({
      repository,
      remoteUrl,
      sourceRef,
      usernameEnv,
      passwordEnv,
    });
  });

  const identities = entries.map((entry) => entry.repository);
  if (new Set(identities).size !== identities.length) {
    throw invalidConfig(
      "repository authorization configuration contains duplicate normalized identities",
    );
  }

  return Object.freeze(entries);
}


export function loadRepositoryAuthorizationConfiguration(
  raw: string | undefined,
): RepositoryAuthorizationConfiguration {
  try {
    return { kind: "configured", entries: parseRepositoryAccessEntries(raw) };
  } catch (error) {
    if (error instanceof RepositoryAccessError) {
      return { kind: "invalid", diagnostic: error.message };
    }
    return {
      kind: "invalid",
      diagnostic: "repository authorization configuration is invalid",
    };
  }
}

export class RepositoryAccessPolicy {
  readonly #entries: readonly RepositoryAccessEntry[];
  readonly #configurationDiagnostic: string | undefined;

  constructor(configuration: RepositoryAuthorizationConfiguration) {
    if (configuration.kind === "invalid") {
      this.#entries = [];
      this.#configurationDiagnostic = configuration.diagnostic;
      return;
    }
    const identities = configuration.entries.map((entry) => entry.repository);
    if (new Set(identities).size !== identities.length) {
      this.#entries = [];
      this.#configurationDiagnostic = "repository authorization entries are ambiguous";
      return;
    }
    this.#entries = [...configuration.entries];
    this.#configurationDiagnostic = undefined;
  }

  authorize(repository: string): RepositoryAccessEntry {
    if (this.#configurationDiagnostic !== undefined) {
      throw new RepositoryAccessError(
        "authorization_configuration_invalid",
        "repository authorization configuration is invalid or unavailable",
      );
    }
    // Runtime identity is deliberately not trimmed, case-folded, URL-rewritten,
    // percent-decoded, or otherwise normalized here.
    const matches = this.#entries.filter((entry) => entry.repository === repository);
    if (matches.length !== 1) {
      throw new RepositoryAccessError(
        "repository_unauthorized",
        "repository is not authorized for credentialed access",
      );
    }
    return matches[0]!;
  }
}

export class EnvironmentRepositoryCredentialProvider {
  readonly #env: Environment;

  constructor(env: Environment = process.env) {
    this.#env = env;
  }

  getCredential(entry: RepositoryAccessEntry): RepositoryCredential {
    const username = this.#env[entry.usernameEnv];
    const password = this.#env[entry.passwordEnv];
    if (username === undefined || username === "" || password === undefined || password === "") {
      throw new RepositoryAccessError(
        "credential_unavailable",
        "read-only repository credential is unavailable",
      );
    }
    return { username, password };
  }
}

export interface RepositoryCredentialProvider {
  getCredential(entry: RepositoryAccessEntry): RepositoryCredential;
}

function trimAsciiEdgeWhitespace(value: string): string {
  return value.replace(ASCII_EDGE_WHITESPACE, "");
}

function validateRemoteUrl(remoteUrl: string, index: number): void {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw invalidConfig(`repository configuration entry ${index + 1} has an invalid remote URL`);
  }
  if (parsed.protocol !== "https:") {
    throw invalidConfig(
      `repository configuration entry ${index + 1} must use an https remote URL`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw invalidConfig(
      `repository configuration entry ${index + 1} remote URL must not contain credentials, query, or fragment`,
    );
  }
}

function validateSourceRef(sourceRef: string, index: number): void {
  if (
    sourceRef === "" ||
    sourceRef.startsWith("-") ||
    /[\x00-\x20~^:?*[\\]/u.test(sourceRef)
  ) {
    throw invalidConfig(`repository configuration entry ${index + 1} has an invalid source ref`);
  }
}

function validateCredentialEnvName(
  value: string,
  index: number,
  kind: "username" | "password",
): void {
  if (!ENV_NAME_PATTERN.test(value)) {
    throw invalidConfig(
      `repository configuration entry ${index + 1} has an invalid ${kind} environment name`,
    );
  }
}

function invalidConfig(message: string): RepositoryAccessError {
  return new RepositoryAccessError("authorization_configuration_invalid", message);
}
