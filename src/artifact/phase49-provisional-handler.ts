import type {
  ProvisionalAgentExecutionResult,
  ProvisionalAgentResultHandler,
} from "../agent/types.js";
import type { PreparedExecution } from "../execution/types.js";
import type { RepositoryCheckoutResult } from "../repository/types.js";
import type { TaskWorkspace } from "../sandbox/types.js";
import type { DevelopmentChangeSetCollector } from "../development/change-set.js";
import type { Phase49DevelopmentHandoffInput } from "./contract.js";
import type { Phase49FinalizationResult } from "./phase49-finalization.js";

export interface Phase49ProvisionalFinalizationPort {
  finalize(handoff: Phase49DevelopmentHandoffInput): Promise<Phase49FinalizationResult>;
}

/**
 * Production continuation from Phase 48 provisional success into the Phase 49
 * durable-artifact pipeline. The local workspace is consumed exactly once,
 * before Phase 48 disposes it, and is never treated as durable state.
 */
export class Phase49ProvisionalResultHandler implements ProvisionalAgentResultHandler {
  readonly #collector: DevelopmentChangeSetCollector;
  readonly #finalization: Phase49ProvisionalFinalizationPort;

  constructor(input: {
    readonly collector: DevelopmentChangeSetCollector;
    readonly finalization: Phase49ProvisionalFinalizationPort;
  }) {
    this.#collector = input.collector;
    this.#finalization = input.finalization;
  }

  async handle(input: {
    readonly execution: PreparedExecution;
    readonly result: ProvisionalAgentExecutionResult;
    readonly workspace: TaskWorkspace;
    readonly checkout: RepositoryCheckoutResult;
  }): Promise<void> {
    assertImmutableBoundary(input);
    const localChangeSet = await this.#collector.collect(input.workspace.path);
    await this.#finalization.finalize(Object.freeze({
      executionId: input.execution.input.executionId,
      issueId: input.execution.input.issueId,
      repository: input.execution.input.repository,
      sourceRevision: input.execution.input.sourceRevision,
      briefRevision: input.execution.input.briefRevision,
      persistedRevision: input.execution.input.persistedRevision,
      requirementsFingerprint: input.execution.input.requirementsFingerprint,
      provisionalOutcome: input.result.outcome,
      changedFiles: localChangeSet.changedFiles,
      localChangeSet,
    }));
  }
}

function assertImmutableBoundary(input: {
  readonly execution: PreparedExecution;
  readonly workspace: TaskWorkspace;
  readonly checkout: RepositoryCheckoutResult;
}): void {
  const identity = input.execution.input;
  if (input.workspace.executionId !== identity.executionId) {
    throw new Error("Phase 49 production handoff workspace identity mismatch");
  }
  if (
    input.checkout.repository !== identity.repository ||
    input.checkout.sourceRevision !== identity.sourceRevision ||
    input.checkout.headRevision !== identity.sourceRevision ||
    input.checkout.targetDir !== input.workspace.path
  ) {
    throw new Error("Phase 49 production handoff checkout identity mismatch");
  }
}

