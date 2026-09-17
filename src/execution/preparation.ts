import { randomUUID } from "node:crypto";

import type { PreExecutionRejectionWriter } from "../controller/types.js";
import type {
  ExactSourceResolvedHandler,
  ExactSourceResolvedInput,
} from "../repository/types.js";
import type {
  AgentRunningConfirmedHandler,
  AgentRunningDurableWriter,
  ApprovedBriefExecutionReference,
  ExecutionIdAllocator,
  FormalAuthorizationGate,
  ImmutableExecutionInput,
  LogicalExecutionRecord,
  PreparedExecution,
} from "./types.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export class UuidV4ExecutionIdAllocator implements ExecutionIdAllocator {
  allocate(): string {
    const executionId = randomUUID();
    if (!UUID_V4_PATTERN.test(executionId)) {
      throw new Error("execution_id allocator produced a non-canonical UUIDv4");
    }
    return executionId;
  }
}

export class Phase48_3ExactSourceResolvedHandler
  implements ExactSourceResolvedHandler
{
  readonly #formalGate: FormalAuthorizationGate;
  readonly #rejectionWriter: PreExecutionRejectionWriter;
  readonly #executionIdAllocator: ExecutionIdAllocator;
  readonly #agentRunningWriter: AgentRunningDurableWriter;
  readonly #next: AgentRunningConfirmedHandler;
  readonly #clock: () => Date;

  constructor(input: {
    readonly formalGate: FormalAuthorizationGate;
    readonly rejectionWriter: PreExecutionRejectionWriter;
    readonly executionIdAllocator?: ExecutionIdAllocator;
    readonly agentRunningWriter: AgentRunningDurableWriter;
    readonly next: AgentRunningConfirmedHandler;
    readonly clock?: () => Date;
  }) {
    this.#formalGate = input.formalGate;
    this.#rejectionWriter = input.rejectionWriter;
    this.#executionIdAllocator = input.executionIdAllocator ?? new UuidV4ExecutionIdAllocator();
    this.#agentRunningWriter = input.agentRunningWriter;
    this.#next = input.next;
    this.#clock = input.clock ?? (() => new Date());
  }

  async handle(input: ExactSourceResolvedInput): Promise<void> {
    let approvedBriefReference: ApprovedBriefExecutionReference;
    try {
      approvedBriefReference = requireApprovedBriefReference(input);
    } catch (error) {
      await this.#rejectionWriter.reject({
        issueId: input.issue.issueId,
        outcome: "eligibility_failed",
        diagnostic: handoffInvariantDiagnostic(error),
      });
      return;
    }

    try {
      await this.#formalGate.authorize({
        repository: input.repository,
        sourceRevision: input.sourceRevision,
      });
    } catch (error) {
      await this.#rejectionWriter.reject({
        issueId: input.issue.issueId,
        outcome: "eligibility_failed",
        diagnostic: formalGateDiagnostic(error),
      });
      return;
    }

    // The allocation boundary is intentionally below all successful
    // pre-execution invariants and the formal gate.
    const executionId = this.#executionIdAllocator.allocate();
    const startedAt = canonicalStartedAt(this.#clock());
    const snapshot = createImmutableExecutionInput(
      input,
      executionId,
      approvedBriefReference,
    );
    const record = createLogicalExecutionRecord(snapshot, startedAt);
    const execution: PreparedExecution = Object.freeze({
      issue: input.issue,
      handoff: input.handoff,
      input: snapshot,
      record,
    });

    // Any failure or ambiguous result here occurs after execution_id allocation.
    // It is not rewritten as an execution-ID-less pre-execution rejection.
    await this.#agentRunningWriter.persistAndConfirm(execution);
    await this.#next.handle(execution);
  }
}

function requireApprovedBriefReference(
  input: ExactSourceResolvedInput,
): ApprovedBriefExecutionReference {
  if (input.issue.issueId !== input.handoff.issueId) {
    throw new Error("validated handoff Issue identity changed before execution preparation");
  }
  if (input.repository !== input.handoff.repository) {
    throw new Error("validated handoff repository identity changed before formal authorization");
  }
  const approval = input.handoff.approval;
  if (approval === undefined) {
    throw new Error("validated handoff does not expose approved Brief identity");
  }
  if (approval.briefRevision <= 0 || !Number.isSafeInteger(approval.briefRevision)) {
    throw new Error("validated handoff Brief revision is invalid");
  }
  if (approval.persistedRevision.trim() === "") {
    throw new Error("validated handoff persisted revision is blank");
  }
  if (
    input.currentRequirementsFingerprint !==
      input.handoff.approvedRequirementsFingerprint ||
    !FINGERPRINT_PATTERN.test(input.currentRequirementsFingerprint)
  ) {
    throw new Error("validated handoff requirements fingerprint is inconsistent");
  }

  return Object.freeze({
    repository: input.repository,
    issueId: input.issue.issueId,
    briefRevision: approval.briefRevision,
    persistedRevision: approval.persistedRevision,
  });
}

function createImmutableExecutionInput(
  input: ExactSourceResolvedInput,
  executionId: string,
  approvedBriefReference: ApprovedBriefExecutionReference,
): ImmutableExecutionInput {
  if (!UUID_V4_PATTERN.test(executionId)) {
    throw new Error("execution_id must be a canonical lowercase UUIDv4");
  }
  return Object.freeze({
    executionId,
    issueId: input.issue.issueId,
    repository: input.repository,
    sourceRevision: input.sourceRevision,
    briefRevision: approvedBriefReference.briefRevision,
    persistedRevision: approvedBriefReference.persistedRevision,
    requirementsFingerprint: input.handoff.approvedRequirementsFingerprint,
    approvedBriefReference,
  });
}

function createLogicalExecutionRecord(
  input: ImmutableExecutionInput,
  startedAt: string,
): LogicalExecutionRecord {
  const pending = Object.freeze({ kind: "pending" }) satisfies {
    readonly kind: "pending";
  };
  return Object.freeze({
    executionId: input.executionId,
    issueId: input.issueId,
    briefRevision: input.briefRevision,
    persistedRevision: input.persistedRevision,
    requirementsFingerprint: input.requirementsFingerprint,
    repository: input.repository,
    sourceRevision: input.sourceRevision,
    startedAt,
    finishedAt: pending,
    outcome: pending,
    artifactReference: pending,
  });
}

function canonicalStartedAt(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new Error("execution start clock returned an invalid timestamp");
  }
  const output = value.toISOString();
  if (!RFC3339_PATTERN.test(output) || output.length > 64) {
    throw new Error("execution start timestamp is outside the Redmine contract");
  }
  return output;
}

function handoffInvariantDiagnostic(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return `execution preparation eligibility failed: ${error.message}`;
  }
  return "execution preparation eligibility failed";
}

function formalGateDiagnostic(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return `formal Phase 47 authorization failed: ${error.message}`;
  }
  return "formal Phase 47 authorization failed";
}
