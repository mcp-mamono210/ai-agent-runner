import {
  canonicalArtifactFailureOutcome,
  type Phase49ArtifactFailureReason,
  type Phase49ArtifactManifest,
  type Phase49ArtifactOutcome,
  type Phase49BuiltArtifact,
  type Phase49DevelopmentHandoffInput,
} from "../artifact/contract.js";
import {
  parsePhase49ArtifactReference,
  type Phase49PersistedArtifact,
} from "../artifact/s3-persistence.js";
import {
  findUniqueCustomField,
  scalarCustomFieldValue,
  type CustomFieldWrite,
  type RedmineIssueRecord,
} from "./domain.js";

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

export const PHASE49_AGENT_RUNNING = "Agent Running" as const;
export const PHASE49_READY_FOR_INDEPENDENT_VERIFICATION =
  "Ready for Independent Verification" as const;
export const PHASE49_NEEDS_HUMAN = "Needs Human" as const;

const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export interface Phase49FinalizationRedmineClient {
  getIssue(issueId: number): Promise<RedmineIssueRecord>;
  updateIssueCustomFields(
    issueId: number,
    customFields: readonly CustomFieldWrite[],
  ): Promise<void>;
}

export interface Phase49SuccessfulFinalizationResult {
  readonly executionId: string;
  readonly issueId: number;
  readonly lifecycle: typeof PHASE49_READY_FOR_INDEPENDENT_VERIFICATION;
  readonly outcome: Phase49ArtifactOutcome;
  readonly artifactReference: string;
  readonly finishedAt: string;
}

export interface Phase49ArtifactFailureFinalizationResult {
  readonly executionId: string;
  readonly issueId: number;
  readonly lifecycle: typeof PHASE49_NEEDS_HUMAN;
  readonly outcome: "artifact_persistence_failed";
  readonly artifactReference: "";
  readonly finishedAt: string;
}

interface Phase49ExecutionIdentity {
  readonly executionId: string;
  readonly issueId: number;
  readonly repository: string;
  readonly sourceRevision: string;
  readonly briefRevision: number;
  readonly persistedRevision: string;
  readonly requirementsFingerprint: string;
}

interface ActiveExecutionSnapshot {
  readonly projectId: number;
  readonly startedAt: string;
}

export class RedminePhase49ExecutionFinalizer {
  readonly #client: Phase49FinalizationRedmineClient;
  readonly #allowedProjectIds: readonly number[];
  readonly #clock: () => Date;

  constructor(input: {
    readonly client: Phase49FinalizationRedmineClient;
    readonly allowedProjectIds: readonly number[];
    readonly clock?: () => Date;
  }) {
    if (input.allowedProjectIds.length === 0) {
      throw new Error("Phase 49 finalizer allowedProjectIds must not be empty");
    }
    this.#client = input.client;
    this.#allowedProjectIds = Object.freeze([...input.allowedProjectIds]);
    this.#clock = input.clock ?? (() => new Date());
  }

  async finalizeSuccess(input: {
    readonly artifact: Phase49BuiltArtifact;
    readonly persisted: Phase49PersistedArtifact;
  }): Promise<Phase49SuccessfulFinalizationResult> {
    assertPersistedArtifactBinding(input.artifact, input.persisted);

    const identity = identityFromManifest(input.artifact.manifest);
    const before = await this.#client.getIssue(identity.issueId);
    const active = assertActiveExecution(before, identity, this.#allowedProjectIds);
    const finishedAt = canonicalTimestamp(this.#clock(), "successful finalization");
    const writes = buildSuccessWrites(
      before,
      input.artifact.manifest.outcome,
      input.persisted.artifactReference,
      finishedAt,
    );

    // Exactly one success write attempt. Once the durable artifact exists, an
    // unconfirmed Redmine result is owned by Phase 49-5 reconciliation. Do not
    // retry the Agent and do not rewrite the execution as artifact failure.
    await this.#client.updateIssueCustomFields(identity.issueId, writes);

    const after = await this.#client.getIssue(identity.issueId);
    assertSuccessfulReadBack(
      after,
      identity,
      active,
      input.artifact.manifest.outcome,
      input.persisted.artifactReference,
      finishedAt,
      this.#allowedProjectIds,
    );

    return Object.freeze({
      executionId: identity.executionId,
      issueId: identity.issueId,
      lifecycle: PHASE49_READY_FOR_INDEPENDENT_VERIFICATION,
      outcome: input.artifact.manifest.outcome,
      artifactReference: input.persisted.artifactReference,
      finishedAt,
    });
  }

  async finalizeArtifactFailure(input: {
    readonly handoff: Phase49DevelopmentHandoffInput;
    readonly reason: Phase49ArtifactFailureReason;
  }): Promise<Phase49ArtifactFailureFinalizationResult> {
    const identity = identityFromHandoff(input.handoff);
    const before = await this.#client.getIssue(identity.issueId);
    const active = assertActiveExecution(before, identity, this.#allowedProjectIds);
    const finishedAt = canonicalTimestamp(this.#clock(), "artifact failure finalization");
    const outcome = canonicalArtifactFailureOutcome(input.reason);
    const writes = buildFailureWrites(before, outcome, finishedAt);

    // One fail-safe write attempt. Failure or ambiguity may leave Agent Running
    // and is handled by the existing recovery/reconciliation boundary.
    await this.#client.updateIssueCustomFields(identity.issueId, writes);

    const after = await this.#client.getIssue(identity.issueId);
    assertFailureReadBack(
      after,
      identity,
      active,
      outcome,
      finishedAt,
      this.#allowedProjectIds,
    );

    return Object.freeze({
      executionId: identity.executionId,
      issueId: identity.issueId,
      lifecycle: PHASE49_NEEDS_HUMAN,
      outcome,
      artifactReference: "",
      finishedAt,
    });
  }
}

function assertPersistedArtifactBinding(
  artifact: Phase49BuiltArtifact,
  persisted: Phase49PersistedArtifact,
): void {
  const parsed = parsePhase49ArtifactReference(persisted.artifactReference);
  if (parsed.bucket !== persisted.bucket || parsed.key !== persisted.key) {
    throw new Error("Phase 49 successful finalization artifact_reference binding mismatch");
  }
  if (!persisted.key.endsWith(`/${artifact.manifest.executionId}.json`)) {
    throw new Error("Phase 49 successful finalization artifact execution binding mismatch");
  }
}

function identityFromManifest(manifest: Phase49ArtifactManifest): Phase49ExecutionIdentity {
  return Object.freeze({
    executionId: manifest.executionId,
    issueId: manifest.issueId,
    repository: manifest.repository,
    sourceRevision: manifest.sourceRevision,
    briefRevision: manifest.briefRevision,
    persistedRevision: manifest.persistedRevision,
    requirementsFingerprint: manifest.requirementsFingerprint,
  });
}

function identityFromHandoff(handoff: Phase49DevelopmentHandoffInput): Phase49ExecutionIdentity {
  return Object.freeze({
    executionId: handoff.executionId,
    issueId: handoff.issueId,
    repository: handoff.repository,
    sourceRevision: handoff.sourceRevision,
    briefRevision: handoff.briefRevision,
    persistedRevision: handoff.persistedRevision,
    requirementsFingerprint: handoff.requirementsFingerprint,
  });
}

function assertActiveExecution(
  issue: RedmineIssueRecord,
  identity: Phase49ExecutionIdentity,
  allowedProjectIds: readonly number[],
): ActiveExecutionSnapshot {
  assertIssueBoundary(issue, identity.issueId, allowedProjectIds);
  assertScalar(issue, FIELD_NAMES.lifecycle, PHASE49_AGENT_RUNNING);
  assertIdentity(issue, identity);
  assertScalar(issue, FIELD_NAMES.finishedAt, "");
  assertScalar(issue, FIELD_NAMES.outcome, "");
  assertScalar(issue, FIELD_NAMES.artifactReference, "");

  const startedAt = scalar(issue, FIELD_NAMES.startedAt);
  if (!RFC3339_PATTERN.test(startedAt)) {
    throw new Error("Phase 49 started execution timestamp is not canonical RFC3339");
  }
  return Object.freeze({ projectId: issue.project.id, startedAt });
}

function buildSuccessWrites(
  issue: RedmineIssueRecord,
  outcome: Phase49ArtifactOutcome,
  artifactReference: string,
  finishedAt: string,
): readonly CustomFieldWrite[] {
  return distinctWrites([
    { id: field(issue, FIELD_NAMES.lifecycle).id, value: PHASE49_READY_FOR_INDEPENDENT_VERIFICATION },
    { id: field(issue, FIELD_NAMES.finishedAt).id, value: finishedAt },
    { id: field(issue, FIELD_NAMES.outcome).id, value: outcome },
    { id: field(issue, FIELD_NAMES.artifactReference).id, value: artifactReference },
  ]);
}

function buildFailureWrites(
  issue: RedmineIssueRecord,
  outcome: "artifact_persistence_failed",
  finishedAt: string,
): readonly CustomFieldWrite[] {
  return distinctWrites([
    { id: field(issue, FIELD_NAMES.lifecycle).id, value: PHASE49_NEEDS_HUMAN },
    { id: field(issue, FIELD_NAMES.finishedAt).id, value: finishedAt },
    { id: field(issue, FIELD_NAMES.outcome).id, value: outcome },
    { id: field(issue, FIELD_NAMES.artifactReference).id, value: "" },
  ]);
}

function assertSuccessfulReadBack(
  issue: RedmineIssueRecord,
  identity: Phase49ExecutionIdentity,
  active: ActiveExecutionSnapshot,
  outcome: Phase49ArtifactOutcome,
  artifactReference: string,
  finishedAt: string,
  allowedProjectIds: readonly number[],
): void {
  assertFinalizedBoundary(issue, identity, active, allowedProjectIds);
  assertScalar(issue, FIELD_NAMES.lifecycle, PHASE49_READY_FOR_INDEPENDENT_VERIFICATION);
  assertScalar(issue, FIELD_NAMES.finishedAt, finishedAt);
  assertScalar(issue, FIELD_NAMES.outcome, outcome);
  assertScalar(issue, FIELD_NAMES.artifactReference, artifactReference);
}

function assertFailureReadBack(
  issue: RedmineIssueRecord,
  identity: Phase49ExecutionIdentity,
  active: ActiveExecutionSnapshot,
  outcome: "artifact_persistence_failed",
  finishedAt: string,
  allowedProjectIds: readonly number[],
): void {
  assertFinalizedBoundary(issue, identity, active, allowedProjectIds);
  assertScalar(issue, FIELD_NAMES.lifecycle, PHASE49_NEEDS_HUMAN);
  assertScalar(issue, FIELD_NAMES.finishedAt, finishedAt);
  assertScalar(issue, FIELD_NAMES.outcome, outcome);
  assertScalar(issue, FIELD_NAMES.artifactReference, "");
}

function assertFinalizedBoundary(
  issue: RedmineIssueRecord,
  identity: Phase49ExecutionIdentity,
  active: ActiveExecutionSnapshot,
  allowedProjectIds: readonly number[],
): void {
  assertIssueBoundary(issue, identity.issueId, allowedProjectIds);
  if (issue.project.id !== active.projectId) {
    throw new Error("Phase 49 finalization project identity changed");
  }
  assertIdentity(issue, identity);
  assertScalar(issue, FIELD_NAMES.startedAt, active.startedAt);
}

function assertIssueBoundary(
  issue: RedmineIssueRecord,
  issueId: number,
  allowedProjectIds: readonly number[],
): void {
  if (issue.id !== issueId) {
    throw new Error("Phase 49 finalization Issue identity mismatch");
  }
  if (!allowedProjectIds.includes(issue.project.id)) {
    throw new Error("Phase 49 finalization is outside allowed projects");
  }
}

function assertIdentity(issue: RedmineIssueRecord, identity: Phase49ExecutionIdentity): void {
  for (const [name, expected] of [
    [FIELD_NAMES.executionId, identity.executionId],
    [FIELD_NAMES.briefRevision, String(identity.briefRevision)],
    [FIELD_NAMES.persistedRevision, identity.persistedRevision],
    [FIELD_NAMES.requirementsFingerprint, identity.requirementsFingerprint],
    [FIELD_NAMES.repository, identity.repository],
    [FIELD_NAMES.sourceRevision, identity.sourceRevision],
  ] as const) {
    assertScalar(issue, name, expected);
  }
}

function distinctWrites(writes: readonly CustomFieldWrite[]): readonly CustomFieldWrite[] {
  const ids = writes.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Phase 49 finalization field binding contains duplicate IDs");
  }
  return Object.freeze([...writes]);
}

function scalar(issue: RedmineIssueRecord, name: string): string {
  return scalarCustomFieldValue(findUniqueCustomField(issue, name));
}

function assertScalar(issue: RedmineIssueRecord, name: string, expected: string): void {
  if (scalar(issue, name) !== expected) {
    throw new Error(`Phase 49 finalization read-back/identity mismatch: ${name}`);
  }
}

function field(issue: RedmineIssueRecord, name: string) {
  return findUniqueCustomField(issue, name);
}

function canonicalTimestamp(value: Date, operation: string): string {
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Phase 49 ${operation} clock returned an invalid timestamp`);
  }
  const output = value.toISOString();
  if (!RFC3339_PATTERN.test(output) || output.length > 64) {
    throw new Error(`Phase 49 ${operation} timestamp is outside the Redmine contract`);
  }
  return output;
}
