import type {
  AgentRunningDurableWriter,
  PreparedExecution,
} from "../execution/types.js";
import {
  findUniqueCustomField,
  scalarCustomFieldValue,
  type CustomFieldWrite,
  type RedmineCustomField,
  type RedmineIssueRecord,
} from "./domain.js";
import type { RedmineRestClient } from "./rest-client.js";

const FIELD_NAMES = {
  lifecycle: "Agent Execution Lifecycle",
  rejectedAt: "Agent Rejection At",
  rejectionOutcome: "Agent Rejection Outcome",
  rejectionDiagnostic: "Agent Rejection Diagnostic",
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
const FIELD_NAME_LIST = Object.values(FIELD_NAMES);

export class RedmineAgentRunningWriter implements AgentRunningDurableWriter {
  readonly #client: RedmineRestClient;
  readonly #allowedProjectIds: readonly number[];

  constructor(input: {
    readonly client: RedmineRestClient;
    readonly allowedProjectIds: readonly number[];
  }) {
    if (input.allowedProjectIds.length === 0) {
      throw new Error("allowedProjectIds must not be empty");
    }
    this.#client = input.client;
    this.#allowedProjectIds = [...input.allowedProjectIds];
  }

  async persistAndConfirm(execution: PreparedExecution): Promise<void> {
    const before = await this.#client.getIssue(execution.input.issueId);
    this.#assertAllowedIssue(before, execution);
    const writes = buildStartWrites(before, execution);

    await this.#client.updateIssueCustomFields(execution.input.issueId, writes);

    const after = await this.#client.getIssue(execution.input.issueId);
    this.#assertAllowedIssue(after, execution);
    assertExactStartReadBack(after, writes);
  }

  #assertAllowedIssue(
    issue: RedmineIssueRecord,
    execution: PreparedExecution,
  ): void {
    if (issue.id !== execution.input.issueId) {
      throw new Error("Agent Running mutation Issue identity mismatch");
    }
    if (!this.#allowedProjectIds.includes(issue.project.id)) {
      throw new Error("Agent Running mutation is outside allowed projects");
    }
    if (issue.project.id !== execution.issue.projectId) {
      throw new Error("Agent Running mutation project identity changed after candidate validation");
    }
  }
}

function buildStartWrites(
  issue: RedmineIssueRecord,
  execution: PreparedExecution,
): readonly CustomFieldWrite[] {
  const fields = new Map<string, RedmineCustomField>();
  for (const name of FIELD_NAME_LIST) {
    fields.set(name, findUniqueCustomField(issue, name));
  }
  const ids = [...fields.values()].map((field) => field.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Agent execution custom-field binding contains duplicate IDs");
  }

  const values = new Map<string, string>([
    [FIELD_NAMES.lifecycle, AGENT_RUNNING],
    [FIELD_NAMES.rejectedAt, ""],
    [FIELD_NAMES.rejectionOutcome, ""],
    [FIELD_NAMES.rejectionDiagnostic, ""],
    [FIELD_NAMES.executionId, execution.input.executionId],
    [FIELD_NAMES.briefRevision, String(execution.input.briefRevision)],
    [FIELD_NAMES.persistedRevision, execution.input.persistedRevision],
    [FIELD_NAMES.requirementsFingerprint, execution.input.requirementsFingerprint],
    [FIELD_NAMES.repository, execution.input.repository],
    [FIELD_NAMES.sourceRevision, execution.input.sourceRevision],
    [FIELD_NAMES.startedAt, execution.record.startedAt],
    [FIELD_NAMES.finishedAt, ""],
    [FIELD_NAMES.outcome, ""],
    [FIELD_NAMES.artifactReference, ""],
  ]);

  return FIELD_NAME_LIST.map((name) => {
    const field = fields.get(name);
    const value = values.get(name);
    if (field === undefined || value === undefined) {
      throw new Error(`Agent execution start projection is incomplete: ${name}`);
    }
    return { id: field.id, value };
  });
}

function assertExactStartReadBack(
  issue: RedmineIssueRecord,
  writes: readonly CustomFieldWrite[],
): void {
  const expectedById = new Map(writes.map((entry) => [entry.id, entry.value]));
  for (const name of FIELD_NAME_LIST) {
    const field = findUniqueCustomField(issue, name);
    const expected = expectedById.get(field.id);
    if (expected === undefined) {
      throw new Error(`Agent Running read-back field binding changed: ${name}`);
    }
    const actual = scalarCustomFieldValue(field);
    if (actual !== expected) {
      throw new Error(`Agent Running read-back mismatch: ${name}`);
    }
  }
}
