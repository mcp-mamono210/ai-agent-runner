export const READY_FOR_AGENT_LIFECYCLE = "Ready for Agent" as const;

export type PreExecutionRejectionOutcome =
  | "stale_requirements"
  | "eligibility_failed";

export interface ReadyForAgentCandidate {
  issueId: number;
  projectId: number;
}

export interface ReFetchedIssue {
  issueId: number;
  projectId: number;
  lifecycle: string;
  raw: unknown;
}

/**
 * Opaque Phase 46 handoff value.
 *
 * Phase 48-1 deliberately does not duplicate the approval / handoff business
 * rules. The injected validator owns validation against the canonical Phase 46
 * contract and returns a validated value only after those rules pass.
 */
export interface ValidatedHandoffApproval {
  readonly approverIdentity: string;
  readonly approvedAt: string;
  readonly briefRevision: number;
  readonly persistedRevision: string;
}

export interface ValidatedHandoff {
  readonly issueId: number;
  readonly repository: string;
  readonly approvedRequirementsFingerprint: string;
  /**
   * Explicit immutable approval identity needed by execution preparation.
   * Older tests/adapters may omit it; production Phase 46 binding supplies it.
   */
  readonly approval?: ValidatedHandoffApproval;
  readonly opaque: unknown;
}

export type HandoffValidationResult =
  | { readonly ok: true; readonly handoff: ValidatedHandoff }
  | { readonly ok: false; readonly diagnostic: string };

/**
 * Reuses the existing requirements canonicalization / fingerprint semantics.
 * The Runner consumes the result and must not define a second fingerprint
 * algorithm here.
 */
export type RequirementsRevalidationResult =
  | { readonly kind: "current"; readonly currentFingerprint: string }
  | {
      readonly kind: "stale";
      readonly currentFingerprint: string;
      readonly approvedFingerprint: string;
      readonly diagnostic?: string;
    }
  | { readonly kind: "failed"; readonly diagnostic: string };

export interface CandidateSource {
  listReadyForAgentCandidates(input: {
    readonly allowedProjectIds: readonly number[];
    readonly lifecycle: typeof READY_FOR_AGENT_LIFECYCLE;
    readonly limit: 1;
  }): Promise<readonly ReadyForAgentCandidate[]>;
}

export interface IssueReader {
  getIssue(issueId: number): Promise<ReFetchedIssue>;
}

export interface HandoffValidator {
  validate(issue: ReFetchedIssue): Promise<HandoffValidationResult>;
}

export interface RequirementsRevalidator {
  revalidate(
    issue: ReFetchedIssue,
    handoff: ValidatedHandoff,
  ): Promise<RequirementsRevalidationResult>;
}

export interface PreExecutionRejectionWriter {
  reject(input: {
    readonly issueId: number;
    readonly outcome: PreExecutionRejectionOutcome;
    readonly diagnostic: string;
  }): Promise<void>;
}

export interface StartupReconciler {
  reconcile(): Promise<void>;
}

export interface EligibleCandidateHandler {
  handle(input: {
    readonly issue: ReFetchedIssue;
    readonly handoff: ValidatedHandoff;
    readonly currentRequirementsFingerprint: string;
  }): Promise<void>;
}

export interface Sleeper {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}
