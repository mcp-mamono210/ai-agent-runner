import type { ReFetchedIssue, ValidatedHandoff } from "../controller/types.js";

export interface FormalAuthorizationInput {
  readonly repository: string;
  readonly sourceRevision: string;
}

export interface FormalAuthorizationGate {
  authorize(input: FormalAuthorizationInput): Promise<void>;
}

export interface ExecutionIdAllocator {
  allocate(): string;
}

export interface ApprovedBriefExecutionReference {
  readonly repository: string;
  readonly issueId: number;
  readonly briefRevision: number;
  readonly persistedRevision: string;
}

export interface ImmutableExecutionInput {
  readonly executionId: string;
  readonly issueId: number;
  readonly repository: string;
  readonly sourceRevision: string;
  readonly briefRevision: number;
  readonly persistedRevision: string;
  readonly requirementsFingerprint: string;
  readonly approvedBriefReference: ApprovedBriefExecutionReference;
}

export interface PendingExecutionValue {
  readonly kind: "pending";
}

export interface LogicalExecutionRecord {
  readonly executionId: string;
  readonly issueId: number;
  readonly briefRevision: number;
  readonly persistedRevision: string;
  readonly requirementsFingerprint: string;
  readonly repository: string;
  readonly sourceRevision: string;
  readonly startedAt: string;
  readonly finishedAt: PendingExecutionValue;
  readonly outcome: PendingExecutionValue;
  readonly artifactReference: PendingExecutionValue;
}

export interface PreparedExecution {
  readonly issue: ReFetchedIssue;
  readonly handoff: ValidatedHandoff;
  readonly input: ImmutableExecutionInput;
  readonly record: LogicalExecutionRecord;
}

export interface AgentRunningDurableWriter {
  persistAndConfirm(execution: PreparedExecution): Promise<void>;
}

/**
 * Phase 48-4 continuation. This is invoked only after the Agent Running start
 * projection has been durably written and exact read-back has succeeded.
 */
export interface AgentRunningConfirmedHandler {
  handle(execution: PreparedExecution): Promise<void>;
}
