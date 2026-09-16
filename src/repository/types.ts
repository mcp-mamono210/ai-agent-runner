import type {
  ReFetchedIssue,
  ValidatedHandoff,
} from "../controller/types.js";

export type RepositoryAccessFailureCode =
  | "authorization_configuration_invalid"
  | "repository_unauthorized"
  | "credential_unavailable"
  | "source_resolution_failed"
  | "checkout_failed";

export class RepositoryAccessError extends Error {
  readonly code: RepositoryAccessFailureCode;

  constructor(code: RepositoryAccessFailureCode, message: string) {
    super(message);
    this.name = "RepositoryAccessError";
    this.code = code;
  }
}

export interface RepositoryCredential {
  readonly username: string;
  readonly password: string;
}

export type RepositoryAuthorizationConfiguration =
  | { readonly kind: "configured"; readonly entries: readonly RepositoryAccessEntry[] }
  | { readonly kind: "invalid"; readonly diagnostic: string };

export interface RepositoryAccessEntry {
  readonly repository: string;
  readonly remoteUrl: string;
  readonly sourceRef: string;
  readonly usernameEnv: string;
  readonly passwordEnv: string;
}

export interface ResolvedSource {
  readonly repository: string;
  readonly sourceRevision: string;
}

export interface RepositorySourceResolver {
  resolveExactSource(repository: string): Promise<ResolvedSource>;
}

export interface RepositoryCheckoutInput {
  readonly repository: string;
  readonly sourceRevision: string;
  readonly targetDir: string;
}

export interface RepositoryCheckoutResult {
  readonly repository: string;
  readonly sourceRevision: string;
  readonly targetDir: string;
  readonly headRevision: string;
}

export interface RepositoryCheckout {
  checkout(input: RepositoryCheckoutInput): Promise<RepositoryCheckoutResult>;
}

export interface ExactSourceResolvedInput {
  readonly issue: ReFetchedIssue;
  readonly handoff: ValidatedHandoff;
  readonly currentRequirementsFingerprint: string;
  readonly repository: string;
  readonly sourceRevision: string;
}

/**
 * Phase 48-3 continuation. The formal Phase 47 gate consumes repository plus
 * the already-fixed exact source revision from this boundary.
 */
export interface ExactSourceResolvedHandler {
  handle(input: ExactSourceResolvedInput): Promise<void>;
}
