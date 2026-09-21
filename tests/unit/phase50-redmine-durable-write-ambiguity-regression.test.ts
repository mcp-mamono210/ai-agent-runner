import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STARTED_FAILURE_RECONCILIATION_FALLBACK } from "../../src/agent/types.js";
import { Phase49SuccessfulFinalizationCoordinator } from "../../src/artifact/phase49-finalization.js";
import type { Phase49BuiltArtifact, Phase49DevelopmentHandoffInput } from "../../src/artifact/contract.js";
import { PHASE49_DEFAULT_S3_PREFIX, type Phase49PersistedArtifact } from "../../src/artifact/s3-persistence.js";
import { AgentController } from "../../src/controller/controller.js";
import { InMemoryIssueLock } from "../../src/controller/local-lock.js";
import type {
  EligibleCandidateHandler,
  PreExecutionRejectionWriter,
  ValidatedHandoff,
} from "../../src/controller/types.js";
import { Phase48_3ExactSourceResolvedHandler } from "../../src/execution/preparation.js";
import type { ExecutionIdAllocator, PreparedExecution } from "../../src/execution/types.js";
import type { CustomFieldWrite, RedmineIssueRecord } from "../../src/redmine/domain.js";
import { RedmineStartedExecutionFailureFinalizer } from "../../src/redmine/execution-finalizer.js";
import { RedmineAgentRunningWriter } from "../../src/redmine/execution-writer.js";
import {
  PHASE49_AGENT_RUNNING,
  PHASE49_READY_FOR_INDEPENDENT_VERIFICATION,
  RedminePhase49ExecutionFinalizer,
  type Phase49FinalizationRedmineClient,
} from "../../src/redmine/phase49-finalizer.js";
import { RedmineRestClient } from "../../src/redmine/rest-client.js";
import {
  Phase50FaultController,
  Phase50InjectedFaultError,
} from "../../src/verification/phase50-harness.js";

const ISSUE_ID = 5429;
const PROJECT_ID = 414;
const REPOSITORY = "mcp-mamono210/ai-agent-runner";
const SOURCE_REVISION = "a".repeat(40);
const REQUIREMENTS_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const EXECUTION_ID_1 = "123e4567-e89b-42d3-a456-426614174000";
const EXECUTION_ID_2 = "123e4567-e89b-42d3-a456-426614174001";
const STARTED_AT = "2026-09-21T12:00:00.000Z";
const FINISHED_AT = "2026-09-21T12:30:00.000Z";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

const FIELD_NAMES = [
  "Agent Execution Lifecycle",
  "Agent Rejection At",
  "Agent Rejection Outcome",
  "Agent Rejection Diagnostic",
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
] as const;

interface MutableField {
  readonly id: number;
  readonly name: string;
  value: string;
}

type RestFaultMode = "normal" | "fi01" | "fi02" | "fi11-definite" | "fi11-remote";

type SuccessfulFinalizationFaultMode = "fi10-definite" | "fi10-remote";

void describe("Phase 50-5 Redmine durable-write / finalization ambiguity regression", () => {
  void it("distinguishes FI-01 definite Agent Running failure and treats later evaluation as a new execution", async () => {
    const faults = new Phase50FaultController();
    const backend = new MutableRestBackend({
      fields: readyForAgentFields(),
      faults,
      mode: "fi01",
    });
    const fixture = controllerFixture(backend, [EXECUTION_ID_1, EXECUTION_ID_2]);

    faults.arm("FI-01");
    await assert.rejects(
      fixture.controller.runOnce(),
      /Redmine request failed before receiving a response/u,
    );

    assert.deepEqual(faults.observed(), ["FI-01"]);
    assert.equal(backend.writeCount, 1);
    assert.equal(backend.value("Agent Execution Lifecycle"), "Ready for Agent");
    assert.equal(backend.value("Agent Execution ID"), "");
    assert.equal(backend.value("Agent Rejection Outcome"), "");
    assert.equal(backend.value("Agent Execution Outcome"), "");
    assert.equal(fixture.agentStartCount(), 0);
    assert.equal(fixture.rejectionCount(), 0);
    assert.equal(fixture.localLock.isHeld(ISSUE_ID), false);
    assert.deepEqual(fixture.allocatedExecutionIds(), [EXECUTION_ID_1]);

    // A later explicit Controller evaluation is new preparation, not an
    // automatic retry of a started Agent. FI-01 is one-shot and the prior
    // durable state remained Ready for Agent.
    await fixture.controller.runOnce();

    assert.equal(backend.writeCount, 2);
    assert.equal(backend.value("Agent Execution Lifecycle"), "Agent Running");
    assert.equal(backend.value("Agent Execution ID"), EXECUTION_ID_2);
    assert.equal(fixture.agentStartCount(), 1);
    assert.deepEqual(fixture.allocatedExecutionIds(), [EXECUTION_ID_1, EXECUTION_ID_2]);
    assert.equal(fixture.localLock.isHeld(ISSUE_ID), false);
  });

  void it("distinguishes FI-02 remote Agent Running success followed by confirmation loss", async () => {
    const faults = new Phase50FaultController();
    const backend = new MutableRestBackend({
      fields: readyForAgentFields(),
      faults,
      mode: "fi02",
    });
    const fixture = controllerFixture(backend, [EXECUTION_ID_1]);

    faults.arm("FI-02");
    await assert.rejects(
      fixture.controller.runOnce(),
      /Redmine request failed before receiving a response/u,
    );

    assert.deepEqual(faults.observed(), ["FI-02"]);
    assert.equal(backend.writeCount, 1);
    assert.equal(backend.value("Agent Execution Lifecycle"), "Agent Running");
    assert.equal(backend.value("Agent Execution ID"), EXECUTION_ID_1);
    assert.equal(backend.value("Agent Execution Outcome"), "");
    assert.equal(fixture.agentStartCount(), 0);
    assert.equal(fixture.rejectionCount(), 0);
    assert.equal(fixture.localLock.isHeld(ISSUE_ID), false);
  });

  void it("keeps FI-10 definite success-finalization failure as Agent Running plus a durable artifact", async () => {
    const faults = new Phase50FaultController();
    faults.arm("FI-10", { timing: "before" });
    const handoff = changesReadyHandoff();
    const persistence = new DurableRecordingPersistence();
    const redmine = new SuccessfulFinalizationBackend(handoff, faults, "fi10-definite");
    const coordinator = phase49Coordinator(persistence, redmine);

    await assert.rejects(
      coordinator.finalize(handoff),
      Phase50InjectedFaultError,
    );

    assert.deepEqual(faults.observed(), ["FI-10"]);
    assert.equal(persistence.persistCount, 1);
    assert.equal(persistence.durableArtifactExists, true);
    assert.equal(redmine.writeCount, 1);
    assert.equal(redmine.value("Agent Execution Lifecycle"), PHASE49_AGENT_RUNNING);
    assert.equal(redmine.value("Agent Execution Outcome"), "");
    assert.equal(redmine.value("Agent Artifact Reference"), "");
    assert.notEqual(redmine.value("Agent Execution Outcome"), "artifact_persistence_failed");
  });

  void it("keeps FI-10 remote-success finalization durable when exact confirmation is lost", async () => {
    const faults = new Phase50FaultController();
    faults.arm("FI-10", { timing: "after" });
    const handoff = changesReadyHandoff();
    const persistence = new DurableRecordingPersistence();
    const redmine = new SuccessfulFinalizationBackend(handoff, faults, "fi10-remote");
    const coordinator = phase49Coordinator(persistence, redmine);

    await assert.rejects(
      coordinator.finalize(handoff),
      Phase50InjectedFaultError,
    );

    assert.deepEqual(faults.observed(), ["FI-10"]);
    assert.equal(persistence.persistCount, 1);
    assert.equal(persistence.durableArtifactExists, true);
    assert.equal(redmine.writeCount, 1);
    assert.equal(
      redmine.value("Agent Execution Lifecycle"),
      PHASE49_READY_FOR_INDEPENDENT_VERIFICATION,
    );
    assert.equal(redmine.value("Agent Execution Outcome"), "changes_ready");
    assert.match(redmine.value("Agent Artifact Reference"), /^s3:\/\//u);
  });

  void it("keeps FI-11 definite started-failure classification non-durable and uses interrupted as recovery identity", async () => {
    for (const outcome of ["agent_start_failed", "agent_failed", "timeout"] as const) {
      const faults = new Phase50FaultController();
      faults.arm("FI-11", { timing: "before" });
      const execution = startedExecution();
      const backend = new MutableRestBackend({
        fields: startedExecutionFields(execution),
        faults,
        mode: "fi11-definite",
      });
      const finalizer = startedFailureFinalizer(backend);

      await assert.rejects(
        finalizer.finalizeFailure({ execution, outcome }),
        /Redmine request failed before receiving a response/u,
      );

      assert.deepEqual(faults.observed(), ["FI-11"]);
      assert.equal(backend.writeCount, 1);
      assert.equal(backend.value("Agent Execution Lifecycle"), "Agent Running");
      assert.equal(backend.value("Agent Execution Outcome"), "");
      assert.equal(backend.value("Agent Execution Finished At"), "");
      assert.equal(backend.value("Agent Artifact Reference"), "");
    }

    // The observed in-memory classification is not a durable recovery key.
    // Restart convergence itself remains Phase 50-6 ownership.
    assert.equal(STARTED_FAILURE_RECONCILIATION_FALLBACK, "interrupted");
  });

  void it("keeps FI-11 remote-success started-failure finalization durable without blind retry", async () => {
    const faults = new Phase50FaultController();
    faults.arm("FI-11", { timing: "after" });
    const execution = startedExecution();
    const backend = new MutableRestBackend({
      fields: startedExecutionFields(execution),
      faults,
      mode: "fi11-remote",
    });
    const finalizer = startedFailureFinalizer(backend);

    await assert.rejects(
      finalizer.finalizeFailure({ execution, outcome: "agent_failed" }),
      /Redmine request failed before receiving a response/u,
    );

    assert.deepEqual(faults.observed(), ["FI-11"]);
    assert.equal(backend.writeCount, 1);
    assert.equal(backend.value("Agent Execution Lifecycle"), "Needs Human");
    assert.equal(backend.value("Agent Execution Outcome"), "agent_failed");
    assert.equal(backend.value("Agent Artifact Reference"), "");
    assert.notEqual(backend.value("Agent Execution Finished At"), "");
  });
});

function controllerFixture(
  backend: MutableRestBackend,
  executionIds: readonly string[],
): {
  readonly controller: AgentController;
  readonly localLock: InMemoryIssueLock;
  readonly agentStartCount: () => number;
  readonly rejectionCount: () => number;
  readonly allocatedExecutionIds: () => readonly string[];
} {
  const handoff = validatedHandoff();
  const allocation = new SequenceExecutionIdAllocator(executionIds);
  let agentStarts = 0;
  let rejections = 0;
  const localLock = new InMemoryIssueLock();
  const client = new RedmineRestClient({
    baseUrl: "https://redmine.example.test",
    readApiKey: "read-key",
    writeApiKey: "write-key",
    fetchImpl: (input, init) => backend.fetch(input, init),
  });
  const preparation = new Phase48_3ExactSourceResolvedHandler({
    formalGate: { authorize: () => Promise.resolve() },
    rejectionWriter: {
      reject: () => {
        rejections += 1;
        return Promise.resolve();
      },
    },
    executionIdAllocator: allocation,
    agentRunningWriter: new RedmineAgentRunningWriter({
      client,
      allowedProjectIds: [PROJECT_ID],
    }),
    next: {
      handle: () => {
        agentStarts += 1;
        return Promise.resolve();
      },
    },
    clock: () => new Date(STARTED_AT),
  });
  const eligible: EligibleCandidateHandler = {
    handle: (input) => preparation.handle({
      issue: input.issue,
      handoff: input.handoff,
      currentRequirementsFingerprint: input.currentRequirementsFingerprint,
      repository: REPOSITORY,
      sourceRevision: SOURCE_REVISION,
    }),
  };
  const rejectionWriter: PreExecutionRejectionWriter = {
    reject: () => {
      rejections += 1;
      return Promise.resolve();
    },
  };
  const controller = new AgentController(
    { allowedProjectIds: [PROJECT_ID], pollIntervalMs: 30_000 },
    {
      candidateSource: {
        listReadyForAgentCandidates: () => Promise.resolve([{ issueId: ISSUE_ID, projectId: PROJECT_ID }]),
      },
      issueReader: {
        getIssue: () => Promise.resolve({
          issueId: ISSUE_ID,
          projectId: PROJECT_ID,
          lifecycle: backend.value("Agent Execution Lifecycle"),
          raw: {},
        }),
      },
      handoffValidator: {
        validate: () => Promise.resolve({ ok: true, handoff } as const),
      },
      requirementsRevalidator: {
        revalidate: () => Promise.resolve({
          kind: "current" as const,
          currentFingerprint: REQUIREMENTS_FINGERPRINT,
        }),
      },
      rejectionWriter,
      startupReconciler: { reconcile: () => Promise.resolve() },
      eligibleCandidateHandler: eligible,
      localLock,
      sleeper: { sleep: () => Promise.resolve() },
    },
  );

  return Object.freeze({
    controller,
    localLock,
    agentStartCount: () => agentStarts,
    rejectionCount: () => rejections,
    allocatedExecutionIds: () => allocation.allocated(),
  });
}

class SequenceExecutionIdAllocator implements ExecutionIdAllocator {
  readonly #values: readonly string[];
  readonly #allocated: string[] = [];
  #index = 0;

  constructor(values: readonly string[]) {
    this.#values = values;
  }

  allocate(): string {
    const value = this.#values[this.#index];
    if (value === undefined) {
      throw new Error("no deterministic execution_id remains");
    }
    this.#index += 1;
    this.#allocated.push(value);
    return value;
  }

  allocated(): readonly string[] {
    return Object.freeze([...this.#allocated]);
  }
}

class MutableRestBackend {
  readonly #fields: MutableField[];
  readonly #faults: Phase50FaultController;
  readonly #mode: RestFaultMode;
  getCount = 0;
  writeCount = 0;

  constructor(input: {
    readonly fields: MutableField[];
    readonly faults: Phase50FaultController;
    readonly mode: RestFaultMode;
  }) {
    this.#fields = input.fields;
    this.#faults = input.faults;
    this.#mode = input.mode;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = requestUrl(input);
    if (!url.pathname.endsWith(`/issues/${ISSUE_ID}.json`)) {
      return new Response("not found", { status: 404 });
    }

    if ((init?.method ?? "GET") === "PUT") {
      this.writeCount += 1;
      const operation = (): Response => {
        this.#applyWrites(init?.body);
        return new Response(null, { status: 204 });
      };
      if (this.#mode === "fi01") {
        return await this.#faults.around("FI-01", operation);
      }
      if (this.#mode === "fi11-definite") {
        return await this.#faults.around("FI-11", operation);
      }
      return operation();
    }

    this.getCount += 1;
    const operation = (): Response => new Response(
      JSON.stringify(issuePayload(this.#fields)),
      { status: 200 },
    );
    if (this.#mode === "fi02" && this.getCount >= 2) {
      return await this.#faults.around("FI-02", operation);
    }
    if (this.#mode === "fi11-remote" && this.getCount >= 2) {
      return await this.#faults.around("FI-11", operation);
    }
    return operation();
  }

  value(name: string): string {
    const field = this.#fields.find((candidate) => candidate.name === name);
    if (field === undefined) {
      throw new Error(`missing field: ${name}`);
    }
    return field.value;
  }

  #applyWrites(body: BodyInit | null | undefined): void {
    const text = typeof body === "string" ? body : "";
    const parsed = JSON.parse(text) as {
      issue: { custom_fields: Array<{ id: number; value: string }> };
    };
    for (const update of parsed.issue.custom_fields) {
      const target = this.#fields.find((field) => field.id === update.id);
      if (target === undefined) {
        throw new Error("unexpected Redmine custom field write");
      }
      target.value = update.value;
    }
  }
}

class SuccessfulFinalizationBackend implements Phase49FinalizationRedmineClient {
  readonly #fields: MutableField[];
  readonly #faults: Phase50FaultController;
  readonly #mode: SuccessfulFinalizationFaultMode;
  getCount = 0;
  writeCount = 0;

  constructor(
    handoff: Phase49DevelopmentHandoffInput,
    faults: Phase50FaultController,
    mode: SuccessfulFinalizationFaultMode,
  ) {
    this.#fields = startedHandoffFields(handoff);
    this.#faults = faults;
    this.#mode = mode;
  }

  async getIssue(issueId: number): Promise<RedmineIssueRecord> {
    assert.equal(issueId, ISSUE_ID);
    this.getCount += 1;
    const operation = (): RedmineIssueRecord => issueRecord(this.#fields);
    if (this.#mode === "fi10-remote" && this.getCount >= 2) {
      return await this.#faults.around("FI-10", operation);
    }
    return operation();
  }

  async updateIssueCustomFields(
    issueId: number,
    writes: readonly CustomFieldWrite[],
  ): Promise<void> {
    assert.equal(issueId, ISSUE_ID);
    this.writeCount += 1;
    const operation = (): void => applyCustomFieldWrites(this.#fields, writes);
    if (this.#mode === "fi10-definite") {
      await this.#faults.around("FI-10", operation);
      return;
    }
    operation();
  }

  value(name: string): string {
    const field = this.#fields.find((candidate) => candidate.name === name);
    if (field === undefined) {
      throw new Error(`missing field: ${name}`);
    }
    return field.value;
  }
}

class DurableRecordingPersistence {
  persistCount = 0;
  durableArtifactExists = false;

  persistAndConfirm(artifact: Phase49BuiltArtifact): Promise<Phase49PersistedArtifact> {
    this.persistCount += 1;
    this.durableArtifactExists = true;
    const key = `${PHASE49_DEFAULT_S3_PREFIX}/${artifact.manifest.executionId}.json`;
    return Promise.resolve(Object.freeze({
      bucket: "phase50-artifacts-example",
      key,
      artifactReference: `s3://phase50-artifacts-example/${key}`,
      adoptedExistingObject: false,
    }));
  }
}

function phase49Coordinator(
  persistence: DurableRecordingPersistence,
  redmine: SuccessfulFinalizationBackend,
): Phase49SuccessfulFinalizationCoordinator {
  return new Phase49SuccessfulFinalizationCoordinator({
    persistence,
    finalizer: new RedminePhase49ExecutionFinalizer({
      client: redmine,
      allowedProjectIds: [PROJECT_ID],
      clock: () => new Date(FINISHED_AT),
    }),
  });
}

function startedFailureFinalizer(backend: MutableRestBackend): RedmineStartedExecutionFailureFinalizer {
  return new RedmineStartedExecutionFailureFinalizer({
    client: new RedmineRestClient({
      baseUrl: "https://redmine.example.test",
      readApiKey: "read-key",
      writeApiKey: "write-key",
      fetchImpl: (input, init) => backend.fetch(input, init),
    }),
    allowedProjectIds: [PROJECT_ID],
    clock: () => new Date(FINISHED_AT),
  });
}

function validatedHandoff(): ValidatedHandoff {
  return Object.freeze({
    issueId: ISSUE_ID,
    repository: REPOSITORY,
    approvedRequirementsFingerprint: REQUIREMENTS_FINGERPRINT,
    approval: Object.freeze({
      approverIdentity: "redmine-user:3",
      approvedAt: "2026-09-21T11:59:00Z",
      briefRevision: 12,
      persistedRevision: "persisted-revision-12",
    }),
    opaque: {},
  });
}

function startedExecution(): PreparedExecution {
  const pending = Object.freeze({ kind: "pending" }) satisfies { readonly kind: "pending" };
  const handoff = validatedHandoff();
  const reference = Object.freeze({
    repository: REPOSITORY,
    issueId: ISSUE_ID,
    briefRevision: handoff.approval!.briefRevision,
    persistedRevision: handoff.approval!.persistedRevision,
  });
  const input = Object.freeze({
    executionId: EXECUTION_ID_1,
    issueId: ISSUE_ID,
    repository: REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    briefRevision: reference.briefRevision,
    persistedRevision: reference.persistedRevision,
    requirementsFingerprint: REQUIREMENTS_FINGERPRINT,
    approvedBriefReference: reference,
  });
  return Object.freeze({
    issue: { issueId: ISSUE_ID, projectId: PROJECT_ID, lifecycle: "Agent Running", raw: {} },
    handoff,
    input,
    record: Object.freeze({
      executionId: input.executionId,
      issueId: input.issueId,
      briefRevision: input.briefRevision,
      persistedRevision: input.persistedRevision,
      requirementsFingerprint: input.requirementsFingerprint,
      repository: input.repository,
      sourceRevision: input.sourceRevision,
      startedAt: STARTED_AT,
      finishedAt: pending,
      outcome: pending,
      artifactReference: pending,
    }),
  });
}

function changesReadyHandoff(): Phase49DevelopmentHandoffInput {
  return Object.freeze({
    executionId: EXECUTION_ID_1,
    issueId: ISSUE_ID,
    repository: REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    briefRevision: 12,
    persistedRevision: "persisted-revision-12",
    requirementsFingerprint: REQUIREMENTS_FINGERPRINT,
    provisionalOutcome: "changes_ready",
    changedFiles: Object.freeze([{ path: "a.txt", status: "modified" as const }]),
    localChangeSet: Object.freeze({
      patch: Object.freeze({
        text: PATCH,
        capturedBytes: Buffer.byteLength(PATCH, "utf8"),
        truncated: false,
      }),
    }),
  });
}

function readyForAgentFields(): MutableField[] {
  return fieldsFromValues(new Map<string, string>([
    ["Agent Execution Lifecycle", "Ready for Agent"],
  ]));
}

function startedExecutionFields(execution: PreparedExecution): MutableField[] {
  return fieldsFromValues(new Map<string, string>([
    ["Agent Execution Lifecycle", "Agent Running"],
    ["Agent Execution ID", execution.input.executionId],
    ["Agent Exec Brief Revision", String(execution.input.briefRevision)],
    ["Agent Exec Persisted Revision", execution.input.persistedRevision],
    ["Agent Exec Req Fingerprint", execution.input.requirementsFingerprint],
    ["Agent Execution Repository", execution.input.repository],
    ["Agent Exec Source Revision", execution.input.sourceRevision],
    ["Agent Execution Started At", execution.record.startedAt],
  ]));
}

function startedHandoffFields(handoff: Phase49DevelopmentHandoffInput): MutableField[] {
  return fieldsFromValues(new Map<string, string>([
    ["Agent Execution Lifecycle", "Agent Running"],
    ["Agent Execution ID", handoff.executionId],
    ["Agent Exec Brief Revision", String(handoff.briefRevision)],
    ["Agent Exec Persisted Revision", handoff.persistedRevision],
    ["Agent Exec Req Fingerprint", handoff.requirementsFingerprint],
    ["Agent Execution Repository", handoff.repository],
    ["Agent Exec Source Revision", handoff.sourceRevision],
    ["Agent Execution Started At", STARTED_AT],
  ]));
}

function fieldsFromValues(values: ReadonlyMap<string, string>): MutableField[] {
  return FIELD_NAMES.map((name, index) => ({
    id: 11 + index,
    name,
    value: values.get(name) ?? "",
  }));
}

function issuePayload(fields: readonly MutableField[]): unknown {
  return {
    issue: {
      id: ISSUE_ID,
      project: { id: PROJECT_ID, name: "Redmine" },
      tracker: { id: 2, name: "Feature" },
      subject: "Phase 50-5 fixture",
      description: "Phase 50-5 fixture",
      updated_on: "2026-09-21T12:00:00Z",
      custom_fields: fields,
      journals: [],
      relations: [],
      children: [],
    },
  };
}

function issueRecord(fields: readonly MutableField[]): RedmineIssueRecord {
  return {
    id: ISSUE_ID,
    project: { id: PROJECT_ID, name: "Redmine" },
    tracker: { id: 2, name: "Feature" },
    subject: "Phase 50-5 fixture",
    description: "Phase 50-5 fixture",
    customFields: fields.map((field) => ({ ...field })),
    updatedOn: "2026-09-21T12:00:00Z",
    journals: [],
    relations: [],
    children: [],
  };
}

function applyCustomFieldWrites(
  fields: MutableField[],
  writes: readonly CustomFieldWrite[],
): void {
  for (const write of writes) {
    const target = fields.find((field) => field.id === write.id);
    if (target === undefined) {
      throw new Error("unexpected Redmine custom field write");
    }
    target.value = write.value;
  }
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === "string") {
    return new URL(input);
  }
  return new URL(input.url);
}
