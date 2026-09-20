import {
  findUniqueCustomField,
  scalarCustomFieldValue,
  type CustomFieldWrite,
  type RedmineIssueRecord,
} from "./domain.js";
import type { RedmineRestClient } from "./rest-client.js";
import type { InterruptedExecutionFinalizer } from "../recovery/types.js";

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
const INTERRUPTED = "interrupted";
const EXECUTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40,128}$/u;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

interface DurableExecutionIdentity {
  readonly projectId: number;
  readonly values: Readonly<Record<string, string>>;
}

export class RedmineInterruptedExecutionFinalizer implements InterruptedExecutionFinalizer {
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
    this.#allowedProjectIds = Object.freeze([...input.allowedProjectIds]);
    this.#clock = input.clock ?? (() => new Date());
  }

  async finalizeInterrupted(issueId: number): Promise<void> {
    const before = await this.#client.getIssue(issueId);
    if (before.id !== issueId) {
      throw new Error("interrupted finalization Issue identity mismatch");
    }
    const identity = readActiveIdentity(before, this.#allowedProjectIds);
    const finishedAt = canonicalTimestamp(this.#clock());
    const writes = buildWrites(before, finishedAt);

    // One state-reconciliation write attempt per startup pass. Failure or
    // ambiguous completion is left Agent Running when Redmine did not durably
    // move, and a later startup may retry state reconciliation. Agent execution
    // itself is never retried here.
    await this.#client.updateIssueCustomFields(issueId, writes);

    const after = await this.#client.getIssue(issueId);
    assertFinalized(after, issueId, identity, writes, this.#allowedProjectIds);
  }
}

function readActiveIdentity(
  issue: RedmineIssueRecord,
  allowedProjectIds: readonly number[],
): DurableExecutionIdentity {
  if (!allowedProjectIds.includes(issue.project.id)) {
    throw new Error("interrupted finalization is outside allowed projects");
  }
  assertScalar(issue, FIELD_NAMES.lifecycle, AGENT_RUNNING);
  assertScalar(issue, FIELD_NAMES.finishedAt, "");
  assertScalar(issue, FIELD_NAMES.outcome, "");
  assertScalar(issue, FIELD_NAMES.artifactReference, "");

  const values: Record<string, string> = {};
  for (const name of [
    FIELD_NAMES.executionId,
    FIELD_NAMES.briefRevision,
    FIELD_NAMES.persistedRevision,
    FIELD_NAMES.requirementsFingerprint,
    FIELD_NAMES.repository,
    FIELD_NAMES.sourceRevision,
    FIELD_NAMES.startedAt,
  ] as const) {
    values[name] = scalar(issue, name);
  }
  validateIdentity(values);
  return Object.freeze({
    projectId: issue.project.id,
    values: Object.freeze(values),
  });
}

function validateIdentity(values: Readonly<Record<string, string>>): void {
  const executionId = requiredIdentity(values, FIELD_NAMES.executionId);
  if (!EXECUTION_ID_PATTERN.test(executionId)) {
    throw new Error("Agent Running execution_id is not canonical UUIDv4");
  }
  const briefRevision = requiredIdentity(values, FIELD_NAMES.briefRevision);
  if (!/^[1-9]\d*$/u.test(briefRevision) || !Number.isSafeInteger(Number(briefRevision))) {
    throw new Error("Agent Running brief revision is invalid");
  }
  if (requiredIdentity(values, FIELD_NAMES.persistedRevision).trim() === "") {
    throw new Error("Agent Running persisted revision is empty");
  }
  if (!FINGERPRINT_PATTERN.test(requiredIdentity(values, FIELD_NAMES.requirementsFingerprint))) {
    throw new Error("Agent Running requirements fingerprint is invalid");
  }
  if (requiredIdentity(values, FIELD_NAMES.repository).trim() === "") {
    throw new Error("Agent Running repository identity is empty");
  }
  if (!SOURCE_REVISION_PATTERN.test(requiredIdentity(values, FIELD_NAMES.sourceRevision))) {
    throw new Error("Agent Running source revision is invalid");
  }
  if (!RFC3339_PATTERN.test(requiredIdentity(values, FIELD_NAMES.startedAt))) {
    throw new Error("Agent Running started_at is invalid");
  }
}

function buildWrites(issue: RedmineIssueRecord, finishedAt: string): readonly CustomFieldWrite[] {
  return Object.freeze([
    { id: field(issue, FIELD_NAMES.lifecycle).id, value: NEEDS_HUMAN },
    { id: field(issue, FIELD_NAMES.finishedAt).id, value: finishedAt },
    { id: field(issue, FIELD_NAMES.outcome).id, value: INTERRUPTED },
    { id: field(issue, FIELD_NAMES.artifactReference).id, value: "" },
  ]);
}

function assertFinalized(
  issue: RedmineIssueRecord,
  issueId: number,
  identity: DurableExecutionIdentity,
  writes: readonly CustomFieldWrite[],
  allowedProjectIds: readonly number[],
): void {
  if (issue.id !== issueId) {
    throw new Error("interrupted finalization Issue identity mismatch");
  }
  if (!allowedProjectIds.includes(issue.project.id) || issue.project.id !== identity.projectId) {
    throw new Error("interrupted finalization project identity changed");
  }
  for (const [name, expected] of Object.entries(identity.values)) {
    assertScalar(issue, name, expected);
  }

  const expectedById = new Map(writes.map((entry) => [entry.id, entry.value]));
  for (const [name, expected] of [
    [FIELD_NAMES.lifecycle, NEEDS_HUMAN],
    [FIELD_NAMES.outcome, INTERRUPTED],
    [FIELD_NAMES.artifactReference, ""],
  ] as const) {
    const target = field(issue, name);
    if (expectedById.get(target.id) !== expected || scalarCustomFieldValue(target) !== expected) {
      throw new Error(`interrupted finalization read-back mismatch: ${name}`);
    }
  }
  const finishedAtField = field(issue, FIELD_NAMES.finishedAt);
  const expectedFinishedAt = expectedById.get(finishedAtField.id);
  if (expectedFinishedAt === undefined || scalarCustomFieldValue(finishedAtField) !== expectedFinishedAt) {
    throw new Error(`interrupted finalization read-back mismatch: ${FIELD_NAMES.finishedAt}`);
  }
}

function scalar(issue: RedmineIssueRecord, name: string): string {
  return scalarCustomFieldValue(findUniqueCustomField(issue, name));
}

function assertScalar(issue: RedmineIssueRecord, name: string, expected: string): void {
  if (scalar(issue, name) !== expected) {
    throw new Error(`interrupted execution identity/read-back mismatch: ${name}`);
  }
}

function field(issue: RedmineIssueRecord, name: string) {
  return findUniqueCustomField(issue, name);
}

function requiredIdentity(values: Readonly<Record<string, string>>, name: string): string {
  const value = values[name];
  if (value === undefined) {
    throw new Error(`Agent Running identity is missing: ${name}`);
  }
  return value;
}

function canonicalTimestamp(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new Error("interrupted finalization clock returned an invalid timestamp");
  }
  const output = value.toISOString();
  if (!RFC3339_PATTERN.test(output) || output.length > 64) {
    throw new Error("interrupted finalization timestamp is outside the Redmine contract");
  }
  return output;
}
