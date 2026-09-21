import type {
  Phase49ArtifactIdentity,
  Phase49RecoveredArtifact,
} from "../artifact/s3-persistence.js";
import { Phase49S3OperationError } from "../artifact/s3-persistence.js";
import type { Phase49SuccessfulFinalizationResult } from "../redmine/phase49-finalizer.js";
import {
  findUniqueCustomField,
  scalarCustomFieldValue,
  type RedmineIssueRecord,
} from "../redmine/domain.js";
import type { InterruptedExecutionFinalizer } from "./types.js";

const FIELD_NAMES = {
  lifecycle: "Agent Execution Lifecycle",
  executionId: "Agent Execution ID",
  briefRevision: "Agent Exec Brief Revision",
  persistedRevision: "Agent Exec Persisted Revision",
  requirementsFingerprint: "Agent Exec Req Fingerprint",
  repository: "Agent Execution Repository",
  sourceRevision: "Agent Exec Source Revision",
  startedAt: "Agent Execution Started At",
  finishedAt: "Agent Execution Finished At",
  outcome: "Agent Execution Outcome",
  artifactReference: "Agent Artifact Reference",
} as const;

const AGENT_RUNNING = "Agent Running";
const EXECUTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40,128}$/u;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export interface Phase49RecoveryRedmineReader {
  getIssue(issueId: number): Promise<RedmineIssueRecord>;
}

export interface Phase49ArtifactRecoveryPort {
  recoverAndVerify(identity: Phase49ArtifactIdentity): Promise<Phase49RecoveredArtifact>;
}

export interface Phase49RecoverySuccessFinalizer {
  finalizeSuccess(input: {
    readonly artifact: Phase49RecoveredArtifact["artifact"];
    readonly persisted: Phase49RecoveredArtifact["persisted"];
  }): Promise<Phase49SuccessfulFinalizationResult>;
}

/**
 * Replaces the Phase 48 unconditional interrupted fallback at the Phase 49-5
 * boundary while preserving the existing startup cleanup ordering.
 *
 * Explicit S3 not_found means there is no durable artifact and the Phase 48
 * interrupted fallback remains canonical. Any unreadable, access-denied,
 * incomplete, corrupt, or mismatched object is not interpreted as absence and
 * fails closed with the Issue left Agent Running for operator/retry inspection.
 */
export class Phase49ArtifactAwareExecutionReconciler
  implements InterruptedExecutionFinalizer
{
  readonly #reader: Phase49RecoveryRedmineReader;
  readonly #allowedProjectIds: readonly number[];
  readonly #recovery: Phase49ArtifactRecoveryPort;
  readonly #successFinalizer: Phase49RecoverySuccessFinalizer;
  readonly #absentArtifactFinalizer: InterruptedExecutionFinalizer;

  constructor(input: {
    readonly reader: Phase49RecoveryRedmineReader;
    readonly allowedProjectIds: readonly number[];
    readonly recovery: Phase49ArtifactRecoveryPort;
    readonly successFinalizer: Phase49RecoverySuccessFinalizer;
    readonly absentArtifactFinalizer: InterruptedExecutionFinalizer;
  }) {
    if (input.allowedProjectIds.length === 0) {
      throw new Error("Phase 49 artifact reconciliation allowedProjectIds must not be empty");
    }
    this.#reader = input.reader;
    this.#allowedProjectIds = Object.freeze([...input.allowedProjectIds]);
    this.#recovery = input.recovery;
    this.#successFinalizer = input.successFinalizer;
    this.#absentArtifactFinalizer = input.absentArtifactFinalizer;
  }

  async finalizeInterrupted(issueId: number): Promise<void> {
    const issue = await this.#reader.getIssue(issueId);
    const identity = readAgentRunningIdentity(issue, issueId, this.#allowedProjectIds);

    let recovered: Phase49RecoveredArtifact;
    try {
      recovered = await this.#recovery.recoverAndVerify(identity);
    } catch (error) {
      if (error instanceof Phase49S3OperationError && error.kind === "not_found") {
        await this.#absentArtifactFinalizer.finalizeInterrupted(issueId);
        return;
      }
      throw error;
    }

    await this.#successFinalizer.finalizeSuccess({
      artifact: recovered.artifact,
      persisted: recovered.persisted,
    });
  }
}

function readAgentRunningIdentity(
  issue: RedmineIssueRecord,
  expectedIssueId: number,
  allowedProjectIds: readonly number[],
): Phase49ArtifactIdentity {
  if (issue.id !== expectedIssueId) {
    throw new Error("Phase 49 artifact reconciliation Issue identity mismatch");
  }
  if (!allowedProjectIds.includes(issue.project.id)) {
    throw new Error("Phase 49 artifact reconciliation is outside allowed projects");
  }
  assertScalar(issue, FIELD_NAMES.lifecycle, AGENT_RUNNING);
  assertScalar(issue, FIELD_NAMES.finishedAt, "");
  assertScalar(issue, FIELD_NAMES.outcome, "");
  assertScalar(issue, FIELD_NAMES.artifactReference, "");

  const executionId = scalar(issue, FIELD_NAMES.executionId);
  const briefRevisionRaw = scalar(issue, FIELD_NAMES.briefRevision);
  const persistedRevision = scalar(issue, FIELD_NAMES.persistedRevision);
  const requirementsFingerprint = scalar(issue, FIELD_NAMES.requirementsFingerprint);
  const repository = scalar(issue, FIELD_NAMES.repository);
  const sourceRevision = scalar(issue, FIELD_NAMES.sourceRevision);
  const startedAt = scalar(issue, FIELD_NAMES.startedAt);

  if (!EXECUTION_ID_PATTERN.test(executionId)) {
    throw new Error("Phase 49 Agent Running execution_id is not canonical UUIDv4");
  }
  if (!/^[1-9]\d*$/u.test(briefRevisionRaw)) {
    throw new Error("Phase 49 Agent Running brief revision is invalid");
  }
  const briefRevision = Number(briefRevisionRaw);
  if (!Number.isSafeInteger(briefRevision) || briefRevision <= 0) {
    throw new Error("Phase 49 Agent Running brief revision is invalid");
  }
  if (persistedRevision.trim() === "") {
    throw new Error("Phase 49 Agent Running persisted revision is empty");
  }
  if (!FINGERPRINT_PATTERN.test(requirementsFingerprint)) {
    throw new Error("Phase 49 Agent Running requirements fingerprint is invalid");
  }
  if (repository.trim() === "") {
    throw new Error("Phase 49 Agent Running repository identity is empty");
  }
  if (!SOURCE_REVISION_PATTERN.test(sourceRevision)) {
    throw new Error("Phase 49 Agent Running source revision is invalid");
  }
  if (!RFC3339_PATTERN.test(startedAt)) {
    throw new Error("Phase 49 Agent Running started_at is invalid");
  }

  return Object.freeze({
    executionId,
    issueId: expectedIssueId,
    repository,
    sourceRevision,
    briefRevision,
    persistedRevision,
    requirementsFingerprint,
  });
}

function scalar(issue: RedmineIssueRecord, name: string): string {
  return scalarCustomFieldValue(findUniqueCustomField(issue, name));
}

function assertScalar(issue: RedmineIssueRecord, name: string, expected: string): void {
  if (scalar(issue, name) !== expected) {
    throw new Error(`Phase 49 artifact reconciliation identity mismatch: ${name}`);
  }
}
