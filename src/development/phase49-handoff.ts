import type {
  ProvisionalAgentExecutionResult,
  ProvisionalAgentResultHandler,
} from "../agent/types.js";
import type { PreparedExecution } from "../execution/types.js";
import { BoundedUtf8Capture, type CaptureSnapshot } from "../sandbox/resource-policy.js";
import type { RepositoryCheckoutResult } from "../repository/types.js";
import type { TaskWorkspace } from "../sandbox/types.js";
import type {
  DevelopmentChangeSetCollector,
  DevelopmentChangedFile,
  DevelopmentLocalChangeSet,
} from "./change-set.js";

export interface DevelopmentPhase49Handoff {
  readonly executionId: string;
  readonly issueId: number;
  readonly repository: string;
  readonly sourceRevision: string;
  readonly briefRevision: number;
  readonly persistedRevision: string;
  readonly requirementsFingerprint: string;
  readonly provisionalOutcome: "changes_ready" | "no_changes";
  readonly changedFiles: readonly DevelopmentChangedFile[];
  readonly localChangeSet: DevelopmentLocalChangeSet;
  readonly executionSummary: CaptureSnapshot;
}

export interface DevelopmentPhase49HandoffSink {
  record(handoff: DevelopmentPhase49Handoff): Promise<void>;
}

export class InMemoryDevelopmentPhase49HandoffStore
  implements DevelopmentPhase49HandoffSink
{
  readonly #handoffs: DevelopmentPhase49Handoff[] = [];

  record(handoff: DevelopmentPhase49Handoff): Promise<void> {
    this.#handoffs.push(handoff);
    return Promise.resolve();
  }

  list(): readonly DevelopmentPhase49Handoff[] {
    return Object.freeze([...this.#handoffs]);
  }

  clear(): void {
    this.#handoffs.length = 0;
  }
}

export class Phase48_7ProvisionalResultHandler
  implements ProvisionalAgentResultHandler
{
  readonly #collector: DevelopmentChangeSetCollector;
  readonly #sink: DevelopmentPhase49HandoffSink;
  readonly #summaryCaptureBytes: number;

  constructor(input: {
    readonly collector: DevelopmentChangeSetCollector;
    readonly sink: DevelopmentPhase49HandoffSink;
    readonly summaryCaptureBytes: number;
  }) {
    if (!Number.isSafeInteger(input.summaryCaptureBytes) || input.summaryCaptureBytes <= 0) {
      throw new Error("summaryCaptureBytes must be a positive safe integer");
    }
    this.#collector = input.collector;
    this.#sink = input.sink;
    this.#summaryCaptureBytes = input.summaryCaptureBytes;
  }

  async handle(input: {
    readonly execution: PreparedExecution;
    readonly result: ProvisionalAgentExecutionResult;
    readonly workspace: TaskWorkspace;
    readonly checkout: RepositoryCheckoutResult;
  }): Promise<void> {
    assertIdentity(input);
    const localChangeSet = await this.#collector.collect(input.workspace.path);
    assertOutcomeMatchesChangeSet(input.result.outcome, localChangeSet);

    const executionSummary = buildSummary({
      execution: input.execution,
      result: input.result,
      changedFileCount: localChangeSet.changedFiles.length,
      patch: localChangeSet.patch,
      maxBytes: this.#summaryCaptureBytes,
    });

    await this.#sink.record(Object.freeze({
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
      executionSummary,
    }));
  }
}

function assertIdentity(input: {
  readonly execution: PreparedExecution;
  readonly workspace: TaskWorkspace;
  readonly checkout: RepositoryCheckoutResult;
}): void {
  const identity = input.execution.input;
  if (input.workspace.executionId !== identity.executionId) {
    throw new Error("Phase 49 development handoff workspace identity mismatch");
  }
  if (
    input.checkout.repository !== identity.repository ||
    input.checkout.sourceRevision !== identity.sourceRevision ||
    input.checkout.headRevision !== identity.sourceRevision ||
    input.checkout.targetDir !== input.workspace.path
  ) {
    throw new Error("Phase 49 development handoff checkout identity mismatch");
  }
}

function assertOutcomeMatchesChangeSet(
  outcome: "changes_ready" | "no_changes",
  changeSet: DevelopmentLocalChangeSet,
): void {
  const hasChanges = changeSet.changedFiles.length > 0;
  if (outcome === "changes_ready" && !hasChanges) {
    throw new Error("changes_ready result did not produce a local change set");
  }
  if (outcome === "no_changes" && hasChanges) {
    throw new Error("no_changes result produced changed files");
  }
}

function buildSummary(input: {
  readonly execution: PreparedExecution;
  readonly result: ProvisionalAgentExecutionResult;
  readonly changedFileCount: number;
  readonly patch: CaptureSnapshot;
  readonly maxBytes: number;
}): CaptureSnapshot {
  const capture = new BoundedUtf8Capture(input.maxBytes);
  capture.append([
    `execution_id=${input.execution.input.executionId}`,
    `issue_id=${input.execution.input.issueId}`,
    `outcome=${input.result.outcome}`,
    `changed_files=${input.changedFileCount}`,
    `patch_captured_bytes=${input.patch.capturedBytes}`,
    `patch_truncated=${String(input.patch.truncated)}`,
    `agent_output_captured_bytes=${input.result.output.capturedBytes}`,
    `agent_output_truncated=${String(input.result.output.truncated)}`,
    `agent_diagnostic_captured_bytes=${input.result.diagnostic.capturedBytes}`,
    `agent_diagnostic_truncated=${String(input.result.diagnostic.truncated)}`,
  ].join("\n"));
  return capture.snapshot();
}
