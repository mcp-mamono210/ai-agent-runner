import type { ImmutableExecutionInput, PreparedExecution } from "../execution/types.js";
import type { RepositoryCheckoutResult } from "../repository/types.js";
import type { SandboxHandle, TaskWorkspace } from "../sandbox/types.js";
import type { CaptureSnapshot } from "../sandbox/resource-policy.js";

export const STARTED_EXECUTION_FAILURE_OUTCOMES = Object.freeze([
  "timeout",
  "agent_start_failed",
  "agent_failed",
] as const);

export type StartedExecutionFailureOutcome =
  (typeof STARTED_EXECUTION_FAILURE_OUTCOMES)[number];

export const PROVISIONAL_EXECUTION_OUTCOMES = Object.freeze([
  "changes_ready",
  "no_changes",
] as const);

export type ProvisionalExecutionOutcome =
  (typeof PROVISIONAL_EXECUTION_OUTCOMES)[number];

export interface AgentExecutionCapture {
  readonly text: string;
  readonly capturedBytes: number;
  readonly truncated: boolean;
}

export interface AgentExecutionResultBase {
  readonly output: AgentExecutionCapture;
  readonly diagnostic: AgentExecutionCapture;
}

export interface ProvisionalAgentExecutionResult extends AgentExecutionResultBase {
  readonly kind: "provisional_success";
  readonly outcome: ProvisionalExecutionOutcome;
}

export interface FailedAgentExecutionResult extends AgentExecutionResultBase {
  readonly kind: "started_failure";
  readonly outcome: StartedExecutionFailureOutcome;
}

export type AgentExecutionResult =
  | ProvisionalAgentExecutionResult
  | FailedAgentExecutionResult;

export interface AgentAdapterInput {
  readonly workspace: TaskWorkspace;
  readonly sandbox: SandboxHandle;
  readonly executionInput: ImmutableExecutionInput;
}

export interface AgentAdapter {
  runAgent(input: AgentAdapterInput): Promise<AgentExecutionResult>;
}

export interface ProvisionalAgentResultHandler {
  handle(input: {
    readonly execution: PreparedExecution;
    readonly result: ProvisionalAgentExecutionResult;
    readonly workspace: TaskWorkspace;
    readonly checkout: RepositoryCheckoutResult;
  }): Promise<void>;
}

export interface StartedExecutionFailureFinalizer {
  finalizeFailure(input: {
    readonly execution: PreparedExecution;
    readonly outcome: StartedExecutionFailureOutcome;
  }): Promise<void>;
}

export interface CodexProviderCredential {
  readonly apiKey: string;
}

export interface CodexProviderCredentialProvider {
  getCredential(): CodexProviderCredential;
}

export type CodexProcessObservation =
  | {
      readonly kind: "completed";
      readonly exitCode: number;
      readonly output: CaptureSnapshot;
      readonly diagnostic: CaptureSnapshot;
    }
  | {
      readonly kind: "start_failed";
      readonly output: CaptureSnapshot;
      readonly diagnostic: CaptureSnapshot;
    }
  | {
      readonly kind: "aborted";
      readonly reason: "execution_timeout" | "sandbox_enforcement";
      readonly output: CaptureSnapshot;
      readonly diagnostic: CaptureSnapshot;
    };

export interface CodexOneShotRunner {
  run(input: {
    readonly containerId: string;
    readonly prompt: string;
    readonly apiKey: string;
    readonly executionTimeoutMs: number;
    readonly outputCaptureBytes: number;
    readonly diagnosticCaptureBytes: number;
    readonly enforcementSignal: AbortSignal;
  }): Promise<CodexProcessObservation>;
}

export interface WorkingTreeChangeDetector {
  hasChanges(workspacePath: string): Promise<boolean>;
}

/**
 * Phase 48-6 may replace an unconfirmed observed failure with this canonical
 * durable outcome when Redmine remains Agent Running after cleanup/restart.
 */
export const STARTED_FAILURE_RECONCILIATION_FALLBACK = "interrupted" as const;
