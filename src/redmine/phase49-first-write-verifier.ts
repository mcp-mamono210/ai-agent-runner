import {
  findUniqueCustomField,
  scalarCustomFieldValue,
  type CustomFieldWrite,
  type RedmineIssueRecord,
} from "./domain.js";

const FIELD_NAMES = {
  lifecycle: "Agent Execution Lifecycle",
  outcome: "Agent Execution Outcome",
  artifactReference: "Agent Artifact Reference",
} as const;

const READY_FOR_INDEPENDENT_VERIFICATION = "Ready for Independent Verification";
const ARTIFACT_PERSISTENCE_FAILED = "artifact_persistence_failed";

export interface Phase49CompatibilityRedmineClient {
  getIssue(issueId: number): Promise<RedmineIssueRecord>;
  updateIssueCustomFields(issueId: number, customFields: readonly CustomFieldWrite[]): Promise<void>;
}

export class RedminePhase49FirstWriteCompatibilityVerifier {
  readonly #client: Phase49CompatibilityRedmineClient;
  readonly #allowedProjectIds: readonly number[];

  constructor(input: {
    readonly client: Phase49CompatibilityRedmineClient;
    readonly allowedProjectIds: readonly number[];
  }) {
    if (input.allowedProjectIds.length === 0) {
      throw new Error("Phase 49 compatibility allowedProjectIds must not be empty");
    }
    this.#client = input.client;
    this.#allowedProjectIds = Object.freeze([...input.allowedProjectIds]);
  }

  async verify(input: {
    readonly fixtureIssueId: number;
    readonly representativeArtifactReference: string;
  }): Promise<void> {
    assertPositiveInteger(input.fixtureIssueId, "fixtureIssueId");
    if (input.representativeArtifactReference.trim() === "") {
      throw new Error("representativeArtifactReference must not be blank");
    }

    const before = await this.#client.getIssue(input.fixtureIssueId);
    this.#assertFixture(before, input.fixtureIssueId);
    const writes = buildVerificationWrites(before, input.representativeArtifactReference);

    await this.#client.updateIssueCustomFields(input.fixtureIssueId, writes);

    const after = await this.#client.getIssue(input.fixtureIssueId);
    this.#assertFixture(after, input.fixtureIssueId);
    assertExactReadBack(after, writes);
  }

  #assertFixture(issue: RedmineIssueRecord, expectedIssueId: number): void {
    if (issue.id !== expectedIssueId) {
      throw new Error("Phase 49 compatibility fixture Issue identity mismatch");
    }
    if (!this.#allowedProjectIds.includes(issue.project.id)) {
      throw new Error("Phase 49 compatibility fixture is outside allowed projects");
    }
  }
}

function buildVerificationWrites(
  issue: RedmineIssueRecord,
  artifactReference: string,
): readonly CustomFieldWrite[] {
  const lifecycle = findUniqueCustomField(issue, FIELD_NAMES.lifecycle);
  const outcome = findUniqueCustomField(issue, FIELD_NAMES.outcome);
  const artifact = findUniqueCustomField(issue, FIELD_NAMES.artifactReference);

  const ids = [lifecycle.id, outcome.id, artifact.id];
  if (new Set(ids).size !== ids.length) {
    throw new Error("Phase 49 compatibility field binding contains duplicate IDs");
  }

  return Object.freeze([
    { id: lifecycle.id, value: READY_FOR_INDEPENDENT_VERIFICATION },
    { id: outcome.id, value: ARTIFACT_PERSISTENCE_FAILED },
    { id: artifact.id, value: artifactReference },
  ]);
}

function assertExactReadBack(
  issue: RedmineIssueRecord,
  writes: readonly CustomFieldWrite[],
): void {
  const expectedById = new Map(writes.map((entry) => [entry.id, entry.value]));
  for (const name of Object.values(FIELD_NAMES)) {
    const field = findUniqueCustomField(issue, name);
    const expected = expectedById.get(field.id);
    if (expected === undefined) {
      throw new Error(`Phase 49 compatibility read-back field binding changed: ${name}`);
    }
    const actual = scalarCustomFieldValue(field);
    if (actual !== expected) {
      throw new Error(`Phase 49 compatibility read-back mismatch: ${name}`);
    }
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
