import {
  findUniqueCustomField,
  scalarCustomFieldValue,
  type RedmineCustomField,
  type RedmineIssueRecord,
} from "./domain.js";

export const DURABLE_EXECUTION_FIELD_NAMES = Object.freeze([
  "Agent Execution Lifecycle",
  "Agent Execution ID",
  "Agent Exec Brief Revision",
  "Agent Exec Persisted Revision",
  "Agent Exec Req Fingerprint",
  "Agent Execution Repository",
  "Agent Exec Source Revision",
  "Agent Execution Started At",
  "Agent Execution Finished At",
  "Agent Execution Outcome",
  "Agent Artifact Reference",
  "Agent Rejection At",
  "Agent Rejection Outcome",
  "Agent Rejection Diagnostic",
] as const);

export type DurableExecutionFieldName =
  (typeof DURABLE_EXECUTION_FIELD_NAMES)[number];

export function bindPristineDurableExecutionFields(
  issue: RedmineIssueRecord,
): ReadonlyMap<DurableExecutionFieldName, RedmineCustomField> {
  const fields = new Map<DurableExecutionFieldName, RedmineCustomField>();
  for (const name of DURABLE_EXECUTION_FIELD_NAMES) {
    const field = findUniqueCustomField(issue, name);
    if (scalarCustomFieldValue(field) !== "") {
      throw new Error(
        `durable execution/rejection state is not pristine: ${name}`,
      );
    }
    fields.set(name, field);
  }

  const ids = [...fields.values()].map((field) => field.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("durable execution/rejection field binding contains duplicate IDs");
  }

  return fields;
}

export function requireBoundDurableExecutionField(
  fields: ReadonlyMap<DurableExecutionFieldName, RedmineCustomField>,
  name: DurableExecutionFieldName,
): RedmineCustomField {
  const field = fields.get(name);
  if (field === undefined) {
    throw new Error(`durable execution/rejection field binding is incomplete: ${name}`);
  }
  return field;
}
