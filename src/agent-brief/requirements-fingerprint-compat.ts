/**
 * Phase 36 / Phase 39 compatibility binding.
 *
 * This file mirrors the canonical behavior owned by mcp-mamono210/redmine:
 * - src/agent-brief/generation-input.ts (blob a99b84a72eb4bcd21137121ae996ba700608f67c)
 * - src/agent-brief/requirements-fingerprint.ts (blob 4b0f174f12552f7bf7f4882b917e0276a5fff0c5)
 *
 * It is implementation compatibility code, not a competing contract. The
 * canonical Redmine repository remains authoritative. The unit test includes
 * the canonical Phase 39 SHA-256 vector so drift fails closed.
 */
import { createHash } from "node:crypto";

import type { RedmineIssueRecord, RedmineIssueRelation } from "../redmine/domain.js";

const MAX_SERIALIZED_BYTES = 24_576;
const MAX_REQUIREMENT_CUSTOM_FIELDS = 8;
const MAX_JOURNALS = 10;
const MAX_RELATIONS = 20;
const MAX_CHILDREN = 10;
const MAX_NAME_BYTES = 256;
const MAX_SUBJECT_BYTES = 512;
const MAX_DESCRIPTION_BYTES = 8_192;
const MAX_CUSTOM_FIELD_VALUE_BYTES = 1_024;
const MAX_JOURNAL_NOTE_BYTES = 1_024;
const MAX_CHILD_SUBJECT_BYTES = 512;
const FINAL_BUDGET_DESCRIPTION_BYTES = 256;
const REDACTED_VALUE = "[REDACTED]";
const ELLIPSIS = "…";
const RFC3339_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const CREDENTIAL_SENSITIVE_NAME_PATTERN =
  /(password|credential|api[ _]?key|token|secret|authorization)/iu;
const SHA256_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface GenerationInputProjectionPolicy {
  readonly requirementCustomFieldIds?: readonly number[];
  readonly configuredSecrets?: readonly string[];
}

export interface AgentBriefGenerationInput {
  format_version: 1;
  source: {
    redmine_issue_id: number;
    source_updated_on: string;
    project: { id: number; name: string };
    tracker: { id: number; name: string };
    fixed_version?: { id: number; name: string };
    subject: string;
    description: string;
  };
  requirement_custom_fields: Array<{
    id: number;
    name: string;
    value: string | string[];
  }>;
  journal_notes: Array<{ id: number; created_on: string; notes: string }>;
  relations: Array<{
    id: number;
    relation_type: string;
    related_issue_id: number;
    delay?: number;
  }>;
  children: Array<{
    id: number;
    subject: string;
    tracker?: { id: number; name: string };
  }>;
  projection: {
    requirement_custom_field_ids: number[];
    redacted_paths: string[];
    truncated_paths: string[];
    omitted: {
      requirement_custom_fields: number;
      journal_notes: number;
      relations: number;
      children: number;
    };
  };
}

export interface AgentBriefRequirementsFingerprintPayload {
  format_version: 1;
  scope: {
    project_id: number;
    tracker_id: number;
    fixed_version_id?: number;
  };
  subject: string;
  description: string;
  requirement_custom_fields: Array<{
    id: number;
    name: string;
    value: string | string[];
  }>;
  journal_notes: string[];
  relations: Array<{
    relation_type: string;
    related_issue_id: number;
    delay?: number;
  }>;
  children: Array<{
    id: number;
    subject: string;
    tracker_id?: number;
  }>;
}

interface ProjectionTextState {
  configuredSecrets: readonly string[];
  redactedPaths: Set<string>;
  truncatedPaths: Set<string>;
}

export function projectAgentBriefGenerationInputCompat(
  issue: RedmineIssueRecord,
  policy: GenerationInputProjectionPolicy = {},
): AgentBriefGenerationInput {
  validateSourceIssue(issue);
  const requirementCustomFieldIds = normalizeRequirementCustomFieldIds(
    policy.requirementCustomFieldIds,
  );
  const state: ProjectionTextState = {
    configuredSecrets: normalizeConfiguredSecrets(policy.configuredSecrets),
    redactedPaths: new Set<string>(),
    truncatedPaths: new Set<string>(),
  };

  const subject = sanitizeAndBoundText(
    issue.subject,
    "source.subject",
    MAX_SUBJECT_BYTES,
    state,
  );
  if (subject === "") {
    throw new Error("source subject is required");
  }

  const requirementCustomFields = projectRequirementCustomFields(
    issue,
    requirementCustomFieldIds,
    state,
  );
  const journals = projectJournalNotes(issue, state);
  const relations = projectRelations(issue);
  const children = projectChildren(issue, state);

  const input: AgentBriefGenerationInput = {
    format_version: 1,
    source: {
      redmine_issue_id: issue.id,
      source_updated_on: issue.updatedOn,
      project: {
        id: issue.project.id,
        name: sanitizeAndBoundText(
          issue.project.name,
          "source.project.name",
          MAX_NAME_BYTES,
          state,
        ),
      },
      tracker: {
        id: issue.tracker.id,
        name: sanitizeAndBoundText(
          issue.tracker.name,
          "source.tracker.name",
          MAX_NAME_BYTES,
          state,
        ),
      },
      ...(issue.fixedVersion === undefined
        ? {}
        : {
            fixed_version: {
              id: issue.fixedVersion.id,
              name: sanitizeAndBoundText(
                issue.fixedVersion.name,
                "source.fixed_version.name",
                MAX_NAME_BYTES,
                state,
              ),
            },
          }),
      subject,
      description: sanitizeAndBoundText(
        issue.description,
        "source.description",
        MAX_DESCRIPTION_BYTES,
        state,
      ),
    },
    requirement_custom_fields: requirementCustomFields,
    journal_notes: journals.journalNotes,
    relations: relations.relations,
    children: children.children,
    projection: {
      requirement_custom_field_ids: requirementCustomFieldIds,
      redacted_paths: [],
      truncated_paths: [],
      omitted: {
        requirement_custom_fields: 0,
        journal_notes: journals.omittedCount,
        relations: relations.omittedCount,
        children: children.omittedCount,
      },
    },
  };

  syncProjectionMetadata(input, state);
  if (!hasRequirementBearingSource(input)) {
    throw new Error("no requirement-bearing source remains after projection");
  }
  enforceFinalBudget(input, state);
  syncProjectionMetadata(input, state);
  return input;
}

export function calculateAgentBriefRequirementsFingerprintCompat(
  input: AgentBriefGenerationInput,
): string {
  const payload = buildPayload(input);
  const serialized = `${JSON.stringify(canonicalizePayload(payload), null, 2)}\n`;
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
  const fingerprint = `sha256:${digest}`;
  if (!SHA256_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error("invalid SHA-256 requirements fingerprint representation");
  }
  return fingerprint;
}

function buildPayload(
  input: AgentBriefGenerationInput,
): AgentBriefRequirementsFingerprintPayload {
  return {
    format_version: 1,
    scope: {
      project_id: input.source.project.id,
      tracker_id: input.source.tracker.id,
      ...(input.source.fixed_version === undefined
        ? {}
        : { fixed_version_id: input.source.fixed_version.id }),
    },
    subject: input.source.subject,
    description: input.source.description,
    requirement_custom_fields: input.requirement_custom_fields.map((field) => ({
      id: field.id,
      name: field.name,
      value: Array.isArray(field.value) ? [...field.value] : field.value,
    })),
    journal_notes: input.journal_notes.map((journal) => journal.notes),
    relations: input.relations.map((relation) => ({
      relation_type: relation.relation_type,
      related_issue_id: relation.related_issue_id,
      ...(relation.delay === undefined ? {} : { delay: relation.delay }),
    })),
    children: input.children.map((child) => ({
      id: child.id,
      subject: child.subject,
      ...(child.tracker === undefined ? {} : { tracker_id: child.tracker.id }),
    })),
  };
}

function canonicalizePayload(
  payload: AgentBriefRequirementsFingerprintPayload,
): AgentBriefRequirementsFingerprintPayload {
  return {
    format_version: 1,
    scope: {
      project_id: payload.scope.project_id,
      tracker_id: payload.scope.tracker_id,
      ...(payload.scope.fixed_version_id === undefined
        ? {}
        : { fixed_version_id: payload.scope.fixed_version_id }),
    },
    subject: payload.subject,
    description: payload.description,
    requirement_custom_fields: payload.requirement_custom_fields.map((field) => ({
      id: field.id,
      name: field.name,
      value: Array.isArray(field.value) ? [...field.value] : field.value,
    })),
    journal_notes: [...payload.journal_notes],
    relations: payload.relations.map((relation) => ({
      relation_type: relation.relation_type,
      related_issue_id: relation.related_issue_id,
      ...(relation.delay === undefined ? {} : { delay: relation.delay }),
    })),
    children: payload.children.map((child) => ({
      id: child.id,
      subject: child.subject,
      ...(child.tracker_id === undefined ? {} : { tracker_id: child.tracker_id }),
    })),
  };
}

function normalizeText(value: string): string {
  return value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) {
    return value;
  }
  const ellipsisBytes = utf8ByteLength(ELLIPSIS);
  let output = "";
  for (const character of value) {
    if (utf8ByteLength(output + character) + ellipsisBytes > maxBytes) {
      break;
    }
    output += character;
  }
  return `${output}${ELLIPSIS}`;
}

function normalizeConfiguredSecrets(
  configuredSecrets: readonly string[] | undefined,
): string[] {
  return [...new Set((configuredSecrets ?? []).filter((secret) => secret !== ""))].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
}

function sanitizeAndBoundText(
  rawValue: string,
  path: string,
  maxBytes: number,
  state: ProjectionTextState,
): string {
  let value = normalizeText(rawValue);
  const originalValue = value;

  for (const secret of state.configuredSecrets) {
    value = value.split(secret).join(REDACTED_VALUE);
  }
  value = value
    .replace(/(Authorization\s*:\s*)[^\n]+/giu, `$1${REDACTED_VALUE}`)
    .replace(/(X-Redmine-API-Key\s*:\s*)[^\n]+/giu, `$1${REDACTED_VALUE}`)
    .replace(
      /((?:password|credential|api[ _]?key|token|secret)\s*[:=]\s*)[^\s,;\n]+/giu,
      `$1${REDACTED_VALUE}`,
    );

  if (state.configuredSecrets.some((secret) => value.includes(secret))) {
    throw new Error("configured secret could not be sanitized");
  }
  if (value !== originalValue) {
    state.redactedPaths.add(path);
  }

  const bounded = truncateUtf8(value, maxBytes);
  if (bounded !== value) {
    state.truncatedPaths.add(path);
  }
  return bounded;
}

function normalizeRequirementCustomFieldIds(
  ids: readonly number[] | undefined,
): number[] {
  const normalized = [...new Set(ids ?? [])].sort((left, right) => left - right);
  if (
    normalized.length > MAX_REQUIREMENT_CUSTOM_FIELDS ||
    normalized.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new Error("requirement custom-field allowlist is invalid");
  }
  return normalized;
}

function validateSourceIssue(issue: RedmineIssueRecord): void {
  const validNamed = (resource: { readonly id: number; readonly name: string }): boolean =>
    Number.isSafeInteger(resource.id) && resource.id > 0 && resource.name.trim() !== "";
  if (
    !Number.isSafeInteger(issue.id) ||
    issue.id <= 0 ||
    !validNamed(issue.project) ||
    !validNamed(issue.tracker) ||
    (issue.fixedVersion !== undefined && !validNamed(issue.fixedVersion)) ||
    !RFC3339_TIMESTAMP_PATTERN.test(issue.updatedOn)
  ) {
    throw new Error("required Redmine Issue identity is missing or invalid");
  }
}

function projectRequirementCustomFields(
  issue: RedmineIssueRecord,
  ids: readonly number[],
  state: ProjectionTextState,
): AgentBriefGenerationInput["requirement_custom_fields"] {
  const projected: AgentBriefGenerationInput["requirement_custom_fields"] = [];
  for (const id of ids) {
    const field = issue.customFields.find((candidate) => candidate.id === id);
    if (field === undefined || CREDENTIAL_SENSITIVE_NAME_PATTERN.test(field.name)) {
      continue;
    }
    const outputIndex = projected.length;
    const valuePath = `requirement_custom_fields[${outputIndex}].value`;
    const rawValues: readonly string[] =
      typeof field.value === "string" ? [field.value] : field.value;
    const projectedValues = rawValues
      .map((value) =>
        sanitizeAndBoundText(value, valuePath, MAX_CUSTOM_FIELD_VALUE_BYTES, state),
      )
      .filter((value) => value !== "");
    if (projectedValues.length === 0) {
      continue;
    }
    const name = sanitizeAndBoundText(
      field.name,
      `requirement_custom_fields[${outputIndex}].name`,
      MAX_NAME_BYTES,
      state,
    );
    projected.push({
      id,
      name,
      value: Array.isArray(field.value) ? projectedValues : (projectedValues[0] ?? ""),
    });
  }
  return projected;
}

function projectJournalNotes(
  issue: RedmineIssueRecord,
  state: ProjectionTextState,
): {
  journalNotes: AgentBriefGenerationInput["journal_notes"];
  omittedCount: number;
} {
  const candidates = issue.journals
    .filter((journal) => normalizeText(journal.notes) !== "")
    .sort(
      (left, right) =>
        right.createdOn.localeCompare(left.createdOn) || right.id - left.id,
    );
  const selected = candidates
    .slice(0, MAX_JOURNALS)
    .sort(
      (left, right) =>
        left.createdOn.localeCompare(right.createdOn) || left.id - right.id,
    );
  return {
    journalNotes: selected.map((journal, index) => ({
      id: journal.id,
      created_on: journal.createdOn,
      notes: sanitizeAndBoundText(
        journal.notes,
        `journal_notes[${index}].notes`,
        MAX_JOURNAL_NOTE_BYTES,
        state,
      ),
    })),
    omittedCount: Math.max(0, candidates.length - selected.length),
  };
}

function projectRelation(
  sourceIssueId: number,
  relation: RedmineIssueRelation,
): AgentBriefGenerationInput["relations"][number] {
  const relatedIssueId =
    relation.issueId === sourceIssueId
      ? relation.issueToId
      : relation.issueToId === sourceIssueId
        ? relation.issueId
        : 0;
  if (relatedIssueId <= 0) {
    throw new Error("relation does not reference the source issue");
  }
  return {
    id: relation.id,
    relation_type: relation.relationType,
    related_issue_id: relatedIssueId,
    ...(relation.delay === undefined ? {} : { delay: relation.delay }),
  };
}

function projectRelations(issue: RedmineIssueRecord): {
  relations: AgentBriefGenerationInput["relations"];
  omittedCount: number;
} {
  const all = issue.relations
    .map((relation) => projectRelation(issue.id, relation))
    .sort(
      (left, right) =>
        left.relation_type.localeCompare(right.relation_type) ||
        left.related_issue_id - right.related_issue_id ||
        left.id - right.id,
    );
  return {
    relations: all.slice(0, MAX_RELATIONS),
    omittedCount: Math.max(0, all.length - MAX_RELATIONS),
  };
}

function projectChildren(
  issue: RedmineIssueRecord,
  state: ProjectionTextState,
): {
  children: AgentBriefGenerationInput["children"];
  omittedCount: number;
} {
  const sorted = [...issue.children].sort((left, right) => left.id - right.id);
  return {
    children: sorted.slice(0, MAX_CHILDREN).map((child, index) => ({
      id: child.id,
      subject: sanitizeAndBoundText(
        child.subject,
        `children[${index}].subject`,
        MAX_CHILD_SUBJECT_BYTES,
        state,
      ),
      ...(child.tracker === undefined
        ? {}
        : {
            tracker: {
              id: child.tracker.id,
              name: sanitizeAndBoundText(
                child.tracker.name,
                `children[${index}].tracker.name`,
                MAX_NAME_BYTES,
                state,
              ),
            },
          }),
    })),
    omittedCount: Math.max(0, sorted.length - MAX_CHILDREN),
  };
}

function syncProjectionMetadata(
  input: AgentBriefGenerationInput,
  state: ProjectionTextState,
): void {
  input.projection.redacted_paths = [...state.redactedPaths].sort();
  input.projection.truncated_paths = [...state.truncatedPaths].sort();
}

function serializeGenerationInput(input: AgentBriefGenerationInput): string {
  return `${JSON.stringify(input, null, 2)}\n`;
}

function serializedByteLength(input: AgentBriefGenerationInput): number {
  return utf8ByteLength(serializeGenerationInput(input));
}

function hasRequirementBearingSource(input: AgentBriefGenerationInput): boolean {
  return (
    input.source.subject !== "" ||
    input.source.description !== "" ||
    input.requirement_custom_fields.length > 0 ||
    input.journal_notes.length > 0 ||
    input.relations.length > 0 ||
    input.children.length > 0
  );
}

function truncateFinalBudgetCustomField(
  input: AgentBriefGenerationInput,
  fieldIndex: number,
  state: ProjectionTextState,
): void {
  const field = input.requirement_custom_fields[fieldIndex];
  if (field === undefined) {
    return;
  }
  const path = `requirement_custom_fields[${fieldIndex}].value`;
  if (Array.isArray(field.value)) {
    const reduced = field.value.map((value) =>
      truncateUtf8(value, utf8ByteLength(ELLIPSIS)),
    );
    if (reduced.some((value, index) => value !== field.value[index])) {
      field.value = reduced;
      state.truncatedPaths.add(path);
    }
    return;
  }
  const reduced = truncateUtf8(field.value, utf8ByteLength(ELLIPSIS));
  if (reduced !== field.value) {
    field.value = reduced;
    state.truncatedPaths.add(path);
  }
}

function enforceFinalBudget(
  input: AgentBriefGenerationInput,
  state: ProjectionTextState,
): void {
  while (serializedByteLength(input) > MAX_SERIALIZED_BYTES && input.journal_notes.length > 0) {
    input.journal_notes.shift();
    input.projection.omitted.journal_notes += 1;
  }
  while (serializedByteLength(input) > MAX_SERIALIZED_BYTES && input.children.length > 0) {
    input.children.pop();
    input.projection.omitted.children += 1;
  }
  while (serializedByteLength(input) > MAX_SERIALIZED_BYTES && input.relations.length > 0) {
    input.relations.pop();
    input.projection.omitted.relations += 1;
  }
  for (
    let index = input.requirement_custom_fields.length - 1;
    index >= 0 && serializedByteLength(input) > MAX_SERIALIZED_BYTES;
    index -= 1
  ) {
    truncateFinalBudgetCustomField(input, index, state);
    syncProjectionMetadata(input, state);
  }
  if (serializedByteLength(input) > MAX_SERIALIZED_BYTES) {
    const reduced = truncateUtf8(input.source.description, FINAL_BUDGET_DESCRIPTION_BYTES);
    if (reduced !== input.source.description) {
      input.source.description = reduced;
      state.truncatedPaths.add("source.description");
      syncProjectionMetadata(input, state);
    }
  }
  if (serializedByteLength(input) > MAX_SERIALIZED_BYTES) {
    throw new Error("generation input exceeds the final byte budget");
  }
}
