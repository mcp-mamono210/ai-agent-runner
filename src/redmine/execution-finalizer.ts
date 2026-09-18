import type {
  StartedExecutionFailureFinalizer,
  StartedExecutionFailureOutcome,
} from "../agent/types.js";
import type { PreparedExecution } from "../execution/types.js";
import {
  findUniqueCustomField,
  scalarCustomFieldValue,
  type CustomFieldWrite,
  type RedmineIssueRecord,
} from "./domain.js";
import type { RedmineRestClient } from "./rest-client.js";

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
const NEEDS_HUMAN = "Needs Human";
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export class RedmineStartedExecutionFailureFinalizer
  implements StartedExecutionFailureFinalizer
{
  readonly #client: RedmineRestClient;
  readonly #allowedProjectIds: readonly number[];
  readonly #clock: () => Date;

  constructor(input: {
    readonly client: RedmineRestClient;
    readonly allowedProjectIds: readonly number[];
    readonly clock?: () => Date;
  }) {
    if (input.allowedProjectIds.length === 0) {
      throw new Error("allowedProjectIds must not be empty");
    }
    this.#client = input.client;
    this.#allowedProjectIds = [...input.allowedProjectIds];
    this.#clock = input.clock ?? (() => new Date());
  }

  async finalizeFailure(input: {
    readonly execution: PreparedExecution;
    readonly outcome: StartedExecutionFailureOutcome;
  }): Promise<void> {
    const before = await this.#client.getIssue(input.execution.input.issueId);
    assertActiveExecution(before, input.execution, this.#allowedProjectIds);
    const writes = buildFailureWrites(before, input.outcome, canonicalTimestamp(this.#clock()));

    // Exactly one write attempt. Ambiguous or failed completion is left for
    // cleanup + Phase 48-6 startup reconciliation; there is no blind retry.
    await this.#client.updateIssueCustomFields(input.execution.input.issueId, writes);

    const after = await this.#client.getIssue(input.execution.input.issueId);
    assertFinalizedExecution(
      after,
      input.execution,
      input.outcome,
      writes,
      this.#allowedProjectIds,
    );
  }
}

function buildFailureWrites(
  issue: RedmineIssueRecord,
  outcome: StartedExecutionFailureOutcome,
  finishedAt: string,
): readonly CustomFieldWrite[] {
  return Object.freeze([
    { id: field(issue, FIELD_NAMES.lifecycle).id, value: NEEDS_HUMAN },
    { id: field(issue, FIELD_NAMES.finishedAt).id, value: finishedAt },
    { id: field(issue, FIELD_NAMES.outcome).id, value: outcome },
    { id: field(issue, FIELD_NAMES.artifactReference).id, value: "" },
  ]);
}

function assertActiveExecution(
  issue: RedmineIssueRecord,
  execution: PreparedExecution,
  allowedProjectIds: readonly number[],
): void {
  assertIssueBoundary(issue, execution, allowedProjectIds);
  assertScalar(issue, FIELD_NAMES.lifecycle, AGENT_RUNNING);
  assertExecutionIdentity(issue, execution);
  assertScalar(issue, FIELD_NAMES.finishedAt, "");
  assertScalar(issue, FIELD_NAMES.outcome, "");
  assertScalar(issue, FIELD_NAMES.artifactReference, "");
}

function assertFinalizedExecution(
  issue: RedmineIssueRecord,
  execution: PreparedExecution,
  outcome: StartedExecutionFailureOutcome,
  writes: readonly CustomFieldWrite[],
  allowedProjectIds: readonly number[],
): void {
  assertIssueBoundary(issue, execution, allowedProjectIds);
  assertExecutionIdentity(issue, execution);
  const expectedById = new Map(writes.map((entry) => [entry.id, entry.value]));
  for (const [name, expected] of [
    [FIELD_NAMES.lifecycle, NEEDS_HUMAN],
    [FIELD_NAMES.outcome, outcome],
    [FIELD_NAMES.artifactReference, ""],
  ] as const) {
    const target = field(issue, name);
    if (expectedById.get(target.id) !== expected || scalarCustomFieldValue(target) !== expected) {
      throw new Error(`started-execution finalization read-back mismatch: ${name}`);
    }
  }
  const finishedAtField = field(issue, FIELD_NAMES.finishedAt);
  const expectedFinishedAt = expectedById.get(finishedAtField.id);
  if (
    expectedFinishedAt === undefined ||
    scalarCustomFieldValue(finishedAtField) !== expectedFinishedAt
  ) {
    throw new Error(`started-execution finalization read-back mismatch: ${FIELD_NAMES.finishedAt}`);
  }
}

function assertIssueBoundary(
  issue: RedmineIssueRecord,
  execution: PreparedExecution,
  allowedProjectIds: readonly number[],
): void {
  if (issue.id !== execution.input.issueId) {
    throw new Error("started-execution finalization Issue identity mismatch");
  }
  if (!allowedProjectIds.includes(issue.project.id)) {
    throw new Error("started-execution finalization is outside allowed projects");
  }
  if (issue.project.id !== execution.issue.projectId) {
    throw new Error("started-execution finalization project identity changed");
  }
}

function assertExecutionIdentity(
  issue: RedmineIssueRecord,
  execution: PreparedExecution,
): void {
  const expected = [
    [FIELD_NAMES.executionId, execution.input.executionId],
    [FIELD_NAMES.briefRevision, String(execution.input.briefRevision)],
    [FIELD_NAMES.persistedRevision, execution.input.persistedRevision],
    [FIELD_NAMES.requirementsFingerprint, execution.input.requirementsFingerprint],
    [FIELD_NAMES.repository, execution.input.repository],
    [FIELD_NAMES.sourceRevision, execution.input.sourceRevision],
    [FIELD_NAMES.startedAt, execution.record.startedAt],
  ] as const;
  for (const [name, value] of expected) {
    assertScalar(issue, name, value);
  }
}

function assertScalar(issue: RedmineIssueRecord, name: string, expected: string): void {
  const actual = scalarCustomFieldValue(findUniqueCustomField(issue, name));
  if (actual !== expected) {
    throw new Error(`started-execution identity/read-back mismatch: ${name}`);
  }
}

function field(issue: RedmineIssueRecord, name: string) {
  return findUniqueCustomField(issue, name);
}

function canonicalTimestamp(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new Error("failure finalization clock returned an invalid timestamp");
  }
  const output = value.toISOString();
  if (!RFC3339_PATTERN.test(output) || output.length > 64) {
    throw new Error("failure finalization timestamp is outside the Redmine contract");
  }
  return output;
}
