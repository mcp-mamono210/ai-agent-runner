export interface AgentRunningExecutionCandidate {
  readonly issueId: number;
  readonly projectId: number;
}

export interface AgentRunningExecutionSource {
  listAgentRunningExecutions(): Promise<readonly AgentRunningExecutionCandidate[]>;
}

export interface InterruptedExecutionFinalizer {
  finalizeInterrupted(issueId: number): Promise<void>;
}

export interface OrphanCleanupSummary {
  readonly removedSandboxContainers: number;
  readonly removedWorkspaces: number;
}

export interface OrphanRuntimeCleaner {
  cleanup(): Promise<OrphanCleanupSummary>;
}

export type RecoveryDiagnosticKind =
  | "cleanup_failure"
  | "orphan_resource"
  | "reconciliation_failure"
  | "interruption";

export interface RecoveryDiagnosticSink {
  record(input: {
    readonly kind: RecoveryDiagnosticKind;
    readonly issueId?: number;
    readonly message: string;
  }): Promise<void>;
}

export class NoopRecoveryDiagnosticSink implements RecoveryDiagnosticSink {
  record(): Promise<void> {
    return Promise.resolve();
  }
}
