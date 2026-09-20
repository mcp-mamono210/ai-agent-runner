import type { StartupReconciler } from "../controller/types.js";
import type { Redactor } from "../security/redaction.js";
import {
  NoopRecoveryDiagnosticSink,
  type AgentRunningExecutionSource,
  type InterruptedExecutionFinalizer,
  type OrphanRuntimeCleaner,
  type RecoveryDiagnosticKind,
  type RecoveryDiagnosticSink,
} from "./types.js";

export class Phase48_6StartupReconciler implements StartupReconciler {
  readonly #source: AgentRunningExecutionSource;
  readonly #cleaner: OrphanRuntimeCleaner;
  readonly #finalizer: InterruptedExecutionFinalizer;
  readonly #redactor: Redactor;
  readonly #diagnosticSink: RecoveryDiagnosticSink;

  constructor(input: {
    readonly source: AgentRunningExecutionSource;
    readonly cleaner: OrphanRuntimeCleaner;
    readonly finalizer: InterruptedExecutionFinalizer;
    readonly redactor: Redactor;
    readonly diagnosticSink?: RecoveryDiagnosticSink;
  }) {
    this.#source = input.source;
    this.#cleaner = input.cleaner;
    this.#finalizer = input.finalizer;
    this.#redactor = input.redactor;
    this.#diagnosticSink = input.diagnosticSink ?? new NoopRecoveryDiagnosticSink();
  }

  async reconcile(): Promise<void> {
    try {
      const summary = await this.#cleaner.cleanup();
      if (summary.removedSandboxContainers > 0 || summary.removedWorkspaces > 0) {
        await this.#report(
          "orphan_resource",
          `removed transient orphan resources: containers=${summary.removedSandboxContainers} workspaces=${summary.removedWorkspaces}`,
        );
      }
    } catch (error) {
      const message = this.#safeRedact(errorMessage(error));
      await this.#report("cleanup_failure", message);
      throw new Error(`startup recovery cleanup failed: ${message}`);
    }

    const candidates = await this.#source.listAgentRunningExecutions();
    const seen = new Set<number>();
    const failures: Error[] = [];

    for (const candidate of candidates) {
      if (seen.has(candidate.issueId)) {
        const message = `duplicate Agent Running issue in reconciliation source: ${candidate.issueId}`;
        await this.#report("reconciliation_failure", message, candidate.issueId);
        failures.push(new Error(message));
        continue;
      }
      seen.add(candidate.issueId);
      try {
        await this.#finalizer.finalizeInterrupted(candidate.issueId);
        await this.#report(
          "interruption",
          `Agent Running execution finalized as interrupted for issue ${candidate.issueId}`,
          candidate.issueId,
        );
      } catch (error) {
        const message = this.#safeRedact(errorMessage(error));
        await this.#report("reconciliation_failure", message, candidate.issueId);
        failures.push(
          new Error(`interrupted reconciliation remains unconfirmed for issue ${candidate.issueId}: ${message}`),
        );
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "startup reconciliation did not confirm every Agent Running execution",
      );
    }
  }

  async #report(
    kind: RecoveryDiagnosticKind,
    rawMessage: string,
    issueId?: number,
  ): Promise<void> {
    const message = this.#safeRedact(rawMessage);
    try {
      await this.#diagnosticSink.record({
        kind,
        ...(issueId === undefined ? {} : { issueId }),
        message,
      });
    } catch {
      throw new Error("recovery diagnostic sink failed after redaction boundary");
    }
  }

  #safeRedact(raw: string): string {
    try {
      return this.#redactor.redact(raw, "reconciliation_diagnostic");
    } catch {
      return "recovery diagnostic redaction failed; raw content suppressed";
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "unknown recovery failure";
}
