import type {
  PreExecutionRejectionOutcome,
  PreExecutionRejectionWriter,
} from "../controller/types.js";
import {
  findUniqueCustomField,
  scalarCustomFieldValue,
  type CustomFieldWrite,
  type RedmineIssueRecord,
} from "./domain.js";
import type { RedmineRestClient } from "./rest-client.js";

const FIELD_NAMES = {
  lifecycle: "Agent Execution Lifecycle",
  rejectedAt: "Agent Rejection At",
  outcome: "Agent Rejection Outcome",
  diagnostic: "Agent Rejection Diagnostic",
} as const;
const NEEDS_HUMAN = "Needs Human";
const MAX_DIAGNOSTIC_BYTES = 2_048;
const REDACTED_VALUE = "[REDACTED]";
const ELLIPSIS = "…";

export class RedminePreExecutionRejectionWriter
  implements PreExecutionRejectionWriter
{
  readonly #client: RedmineRestClient;
  readonly #clock: () => Date;
  readonly #secretValues: readonly string[];
  readonly #allowedProjectIds: readonly number[];

  constructor(input: {
    readonly client: RedmineRestClient;
    readonly clock?: () => Date;
    readonly secretValues?: readonly string[];
    readonly allowedProjectIds: readonly number[];
  }) {
    this.#client = input.client;
    this.#clock = input.clock ?? (() => new Date());
    this.#secretValues = [...new Set(input.secretValues ?? [])].filter(
      (value) => value !== "",
    );
    if (input.allowedProjectIds.length === 0) {
      throw new Error("allowedProjectIds must not be empty");
    }
    this.#allowedProjectIds = [...input.allowedProjectIds];
  }

  async reject(input: {
    readonly issueId: number;
    readonly outcome: PreExecutionRejectionOutcome;
    readonly diagnostic: string;
  }): Promise<void> {
    const before = await this.#client.getIssue(input.issueId);
    if (!this.#allowedProjectIds.includes(before.project.id)) {
      throw new Error("pre-execution rejection write is outside allowed projects");
    }
    const writes = buildWrites(
      before,
      input.outcome,
      sanitizeDiagnostic(input.diagnostic, this.#secretValues),
      this.#clock().toISOString(),
    );

    await this.#client.updateIssueCustomFields(input.issueId, writes);

    const after = await this.#client.getIssue(input.issueId);
    assertReadBack(after, input.outcome, writes);
  }
}

function buildWrites(
  issue: RedmineIssueRecord,
  outcome: PreExecutionRejectionOutcome,
  diagnostic: string,
  rejectedAt: string,
): readonly CustomFieldWrite[] {
  const lifecycle = findUniqueCustomField(issue, FIELD_NAMES.lifecycle);
  const rejectedAtField = findUniqueCustomField(issue, FIELD_NAMES.rejectedAt);
  const outcomeField = findUniqueCustomField(issue, FIELD_NAMES.outcome);
  const diagnosticField = findUniqueCustomField(issue, FIELD_NAMES.diagnostic);

  return [
    { id: lifecycle.id, value: NEEDS_HUMAN },
    { id: rejectedAtField.id, value: rejectedAt },
    { id: outcomeField.id, value: outcome },
    { id: diagnosticField.id, value: diagnostic },
  ];
}

function assertReadBack(
  issue: RedmineIssueRecord,
  outcome: PreExecutionRejectionOutcome,
  writes: readonly CustomFieldWrite[],
): void {
  const expected = new Map(writes.map((entry) => [entry.id, entry.value]));
  for (const [name, expectedValue] of [
    [FIELD_NAMES.lifecycle, NEEDS_HUMAN],
    [FIELD_NAMES.outcome, outcome],
  ] as const) {
    const field = findUniqueCustomField(issue, name);
    const actual = scalarCustomFieldValue(field);
    if (actual !== expectedValue || expected.get(field.id) !== expectedValue) {
      throw new Error(`Redmine rejection read-back mismatch: ${name}`);
    }
  }

  for (const name of [FIELD_NAMES.rejectedAt, FIELD_NAMES.diagnostic] as const) {
    const field = findUniqueCustomField(issue, name);
    const expectedValue = expected.get(field.id);
    if (expectedValue === undefined || scalarCustomFieldValue(field) !== expectedValue) {
      throw new Error(`Redmine rejection read-back mismatch: ${name}`);
    }
  }
}

export function sanitizeDiagnostic(
  diagnostic: string,
  configuredSecrets: readonly string[],
): string {
  let output = diagnostic.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  for (const secret of configuredSecrets) {
    if (secret !== "") {
      output = output.split(secret).join(REDACTED_VALUE);
    }
  }
  output = output
    .replace(/(Authorization\s*:\s*)[^\n]+/giu, `$1${REDACTED_VALUE}`)
    .replace(/(X-Redmine-API-Key\s*:\s*)[^\n]+/giu, `$1${REDACTED_VALUE}`)
    .replace(
      /((?:password|credential|api[ _]?key|token|secret)\s*[:=]\s*)[^\s,;\n]+/giu,
      `$1${REDACTED_VALUE}`,
    );

  if (configuredSecrets.some((secret) => secret !== "" && output.includes(secret))) {
    throw new Error("diagnostic redaction failed");
  }

  if (output === "") {
    output = "pre-execution eligibility validation failed";
  }
  return truncateUtf8(output, MAX_DIAGNOSTIC_BYTES);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const ellipsisBytes = Buffer.byteLength(ELLIPSIS, "utf8");
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") + ellipsisBytes > maxBytes) {
      break;
    }
    output += character;
  }
  return `${output}${ELLIPSIS}`;
}
