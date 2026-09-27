export const READY_FOR_AGENT_LIFECYCLE = "Ready for Agent" as const;

export const PRE_EXECUTION_REJECTION_OUTCOMES = Object.freeze([
  "stale_requirements",
  "eligibility_failed",
] as const);

export type PreExecutionRejectionOutcome =
  (typeof PRE_EXECUTION_REJECTION_OUTCOMES)[number];

export type CandidateDiagnosticKind =
  | "query_predicate_mismatch"
  | "non_pristine_candidate_skipped"
  | "unexpected_project"
  | "candidate_state_changed"
  | "candidate_scan_exhausted";

export type CandidateDiagnosticReason =
  | "candidate list item did not satisfy the requested project and lifecycle predicate"
  | "post-lock issue identity changed"
  | "post-lock issue project changed"
  | "post-lock brief lifecycle changed"
  | "post-lock execution lifecycle changed"
  | "post-lock execution or rejection record is non-pristine"
  | "candidate scan bound reached without an executable candidate";

export interface CandidateDiagnosticSink {
  record(input: {
    readonly kind: CandidateDiagnosticKind;
    readonly issueId?: number;
    readonly reason: CandidateDiagnosticReason;
  }): Promise<void>;
}

export interface ReadyForAgentCandidate {
  issueId: number;
  projectId: number;
}

export interface PostLockCandidateState {
  readonly executionLifecycle: string;
  readonly executionRecordPristine: boolean;
}

export interface ReFetchedIssue {
  issueId: number;
  projectId: number;
  lifecycle: string;
  /**
   * Production Redmine readers provide the Phase 53 post-lock execution guard.
   * The field remains optional so existing non-Redmine test/dry-run readers do
   * not become a second execution-state contract.
   */
  postLockState?: PostLockCandidateState;
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
    readonly limit: number;
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
