import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPhase49ArtifactFromDevelopmentHandoff,
  type Phase49BuiltArtifact,
  type Phase49DevelopmentHandoffInput,
} from "../../src/artifact/contract.js";
import { PHASE49_CANONICAL_EMPTY_PATCH } from "../../src/artifact/no-changes.js";
import { Phase49SuccessfulFinalizationCoordinator } from "../../src/artifact/phase49-finalization.js";
import {
  PHASE49_DEFAULT_S3_PREFIX,
  Phase49S3ArtifactPersistence,
  type Phase49PersistedArtifact,
  type Phase49S3GetInput,
  type Phase49S3GetObservation,
  type Phase49S3HeadInput,
  type Phase49S3ObjectClient,
  type Phase49S3ObjectObservation,
  type Phase49S3PutInput,
} from "../../src/artifact/s3-persistence.js";
import type { CustomFieldWrite, RedmineIssueRecord } from "../../src/redmine/domain.js";
import {
  PHASE49_AGENT_RUNNING,
  PHASE49_NEEDS_HUMAN,
  PHASE49_READY_FOR_INDEPENDENT_VERIFICATION,
  RedminePhase49ExecutionFinalizer,
} from "../../src/redmine/phase49-finalizer.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SOURCE_REVISION = "a".repeat(40);
const FINGERPRINT = `sha256:${"b".repeat(64)}`;
const FINISHED_AT = "2026-09-21T03:30:00.000Z";
const CHANGES_PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

void describe("Phase 49-4 successful Redmine finalization", () => {
  void it("persists changes_ready before the single Redmine success write and confirms exact read-back", async () => {
    const handoff = changesReadyHandoff();
    const events: string[] = [];
    const persistence = new RecordingPersistence(events);
    const redmine = new InMemoryRedmineClient(handoff, events);
    const coordinator = coordinatorFor(persistence, redmine);

    const result = await coordinator.finalize(handoff);

    assert.equal(result.kind, "ready_for_independent_verification");
    assert.deepEqual(events, ["persist", "redmine-write"]);
    assert.equal(redmine.writeCount, 1);
    assert.equal(redmine.value("Agent Execution Lifecycle"), PHASE49_READY_FOR_INDEPENDENT_VERIFICATION);
    assert.equal(redmine.value("Agent Execution Finished At"), FINISHED_AT);
    assert.equal(redmine.value("Agent Execution Outcome"), "changes_ready");
    assert.match(redmine.value("Agent Artifact Reference"), /^s3:\/\/phase49-artifacts-example\//u);
    assertStartedIdentityPreserved(redmine, handoff);
  });

  void it("finalizes no_changes through the same durable artifact path with canonical empty patch", async () => {
    const handoff = noChangesHandoff();
    const events: string[] = [];
    const persistence = new RecordingPersistence(events);
    const redmine = new InMemoryRedmineClient(handoff, events);
    const coordinator = coordinatorFor(persistence, redmine);

    const result = await coordinator.finalize(handoff);

    assert.equal(result.kind, "ready_for_independent_verification");
    assert.equal(persistence.lastArtifact?.manifest.outcome, "no_changes");
    assert.equal((persistence.lastArtifact?.body.byteLength ?? 0) > 0, true);
    assert.equal(
      persistence.lastArtifact?.manifest.patch.checksumSha256Hex,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    assert.equal(redmine.value("Agent Execution Outcome"), "no_changes");
    assert.equal(redmine.value("Agent Execution Lifecycle"), PHASE49_READY_FOR_INDEPENDENT_VERIFICATION);
  });

  void it("prohibits success when checksum verification data is missing", async () => {
    const handoff = changesReadyHandoff();
    const artifact = buildPhase49ArtifactFromDevelopmentHandoff(handoff);
    const s3 = new FakeS3Client(artifact);
    s3.headOverride = { ...s3.matchingObservation(), checksumSha256Base64: undefined };
    const redmine = new InMemoryRedmineClient(handoff);
    const coordinator = coordinatorFor(
      new Phase49S3ArtifactPersistence({ client: s3, config: s3Config() }),
      redmine,
    );

    const result = await coordinator.finalize(handoff);

    assert.equal(result.kind, "artifact_failure");
    assert.equal(redmine.value("Agent Execution Lifecycle"), PHASE49_NEEDS_HUMAN);
    assert.equal(redmine.value("Agent Execution Outcome"), "artifact_persistence_failed");
    assert.equal(redmine.value("Agent Artifact Reference"), "");
  });

  void it("prohibits success when required metadata is missing", async () => {
    const handoff = changesReadyHandoff();
    const artifact = buildPhase49ArtifactFromDevelopmentHandoff(handoff);
    const s3 = new FakeS3Client(artifact);
    const metadata: Record<string, string | undefined> = { ...artifact.metadata };
    delete metadata["source-revision"];
    s3.headOverride = { ...s3.matchingObservation(), metadata };
    const redmine = new InMemoryRedmineClient(handoff);
    const coordinator = coordinatorFor(
      new Phase49S3ArtifactPersistence({ client: s3, config: s3Config() }),
      redmine,
    );

    const result = await coordinator.finalize(handoff);

    assert.equal(result.kind, "artifact_failure");
    assert.equal(redmine.value("Agent Execution Outcome"), "artifact_persistence_failed");
    assert.equal(redmine.value("Agent Execution Lifecycle"), PHASE49_NEEDS_HUMAN);
  });

  void it("prohibits success when the artifact envelope checksum mismatches", async () => {
    const handoff = changesReadyHandoff();
    const artifact = buildPhase49ArtifactFromDevelopmentHandoff(handoff);
    const s3 = new FakeS3Client(artifact);
    s3.headOverride = { ...s3.matchingObservation(), checksumSha256Base64: "wrong" };
    const redmine = new InMemoryRedmineClient(handoff);
    const coordinator = coordinatorFor(
      new Phase49S3ArtifactPersistence({ client: s3, config: s3Config() }),
      redmine,
    );

    const result = await coordinator.finalize(handoff);

    assert.equal(result.kind, "artifact_failure");
    assert.equal(redmine.value("Agent Execution Outcome"), "artifact_persistence_failed");
  });

  void it("rejects stale started identity instead of finalizing another execution", async () => {
    const handoff = changesReadyHandoff();
    const persistence = new RecordingPersistence([]);
    const redmine = new InMemoryRedmineClient(handoff);
    redmine.setValue("Agent Exec Source Revision", "c".repeat(40));
    const coordinator = coordinatorFor(persistence, redmine);

    await assert.rejects(coordinator.finalize(handoff), /Agent Exec Source Revision/u);
    assert.equal(redmine.writeCount, 0);
    assert.equal(redmine.value("Agent Execution Lifecycle"), PHASE49_AGENT_RUNNING);
  });

  void it("does not retry or convert a successful-finalization write failure into artifact failure", async () => {
    const handoff = changesReadyHandoff();
    const persistence = new RecordingPersistence([]);
    const redmine = new InMemoryRedmineClient(handoff);
    redmine.failWrites = true;
    const coordinator = coordinatorFor(persistence, redmine);

    await assert.rejects(coordinator.finalize(handoff), /simulated Redmine write failure/u);
    assert.equal(redmine.writeCount, 1);
    assert.equal(redmine.value("Agent Execution Lifecycle"), PHASE49_AGENT_RUNNING);
    assert.equal(redmine.value("Agent Execution Outcome"), "");
    assert.equal(persistence.persistCount, 1);
  });

  void it("requires durable Redmine read-back rather than treating request success as completion", async () => {
    const handoff = changesReadyHandoff();
    const persistence = new RecordingPersistence([]);
    const redmine = new InMemoryRedmineClient(handoff);
    redmine.afterWriteMutation = () => {
      redmine.setValue("Agent Artifact Reference", "s3://tampered/reference.json");
    };
    const coordinator = coordinatorFor(persistence, redmine);

    await assert.rejects(coordinator.finalize(handoff), /Agent Artifact Reference/u);
    assert.equal(redmine.writeCount, 1);
  });

  void it("leaves Agent Running when artifact failure finalization itself cannot be durably written", async () => {
    const handoff = changesReadyHandoff();
    const persistence = new ThrowingPersistence();
    const redmine = new InMemoryRedmineClient(handoff);
    redmine.failWrites = true;
    const coordinator = coordinatorFor(persistence, redmine);

    await assert.rejects(coordinator.finalize(handoff), /simulated Redmine write failure/u);
    assert.equal(redmine.writeCount, 1);
    assert.equal(redmine.value("Agent Execution Lifecycle"), PHASE49_AGENT_RUNNING);
    assert.equal(redmine.value("Agent Execution Outcome"), "");
  });

  void it("maps invalid no_changes result validation to the canonical artifact failure outcome", async () => {
    const valid = noChangesHandoff();
    const handoff: Phase49DevelopmentHandoffInput = {
      ...valid,
      changedFiles: [{ path: "unexpected.txt", status: "untracked" }],
      localChangeSet: {
        patch: { text: "unexpected", capturedBytes: 10, truncated: false },
      },
    };
    const persistence = new RecordingPersistence([]);
    const redmine = new InMemoryRedmineClient(handoff);
    const coordinator = coordinatorFor(persistence, redmine);

    const result = await coordinator.finalize(handoff);

    assert.equal(result.kind, "artifact_failure");
    assert.equal(persistence.persistCount, 0);
    assert.equal(redmine.value("Agent Execution Outcome"), "artifact_persistence_failed");
    assert.equal(redmine.value("Agent Artifact Reference"), "");
  });
});

function coordinatorFor(
  persistence: { persistAndConfirm(artifact: Phase49BuiltArtifact): Promise<Phase49PersistedArtifact> },
  redmine: InMemoryRedmineClient,
): Phase49SuccessfulFinalizationCoordinator {
  return new Phase49SuccessfulFinalizationCoordinator({
    persistence,
    finalizer: new RedminePhase49ExecutionFinalizer({
      client: redmine,
      allowedProjectIds: [414],
      clock: () => new Date(FINISHED_AT),
    }),
  });
}

class RecordingPersistence {
  readonly #events: string[];
  persistCount = 0;
  lastArtifact: Phase49BuiltArtifact | undefined;

  constructor(events: string[]) {
    this.#events = events;
  }

  persistAndConfirm(artifact: Phase49BuiltArtifact): Promise<Phase49PersistedArtifact> {
    this.persistCount += 1;
    this.lastArtifact = artifact;
    this.#events.push("persist");
    const key = `${PHASE49_DEFAULT_S3_PREFIX}/${artifact.manifest.executionId}.json`;
    return Promise.resolve(Object.freeze({
      bucket: "phase49-artifacts-example",
      key,
      artifactReference: `s3://phase49-artifacts-example/${key}`,
      adoptedExistingObject: false,
    }));
  }
}

class ThrowingPersistence {
  persistAndConfirm(_artifact: Phase49BuiltArtifact): Promise<Phase49PersistedArtifact> {
    return Promise.reject(new Error("simulated artifact persistence failure"));
  }
}

class InMemoryRedmineClient {
  readonly #events: string[];
  readonly #fields: Array<{ id: number; name: string; value: string }>;
  readonly #issueId: number;
  writeCount = 0;
  failWrites = false;
  afterWriteMutation: (() => void) | undefined;

  constructor(handoff: Phase49DevelopmentHandoffInput, events: string[] = []) {
    this.#events = events;
    this.#issueId = handoff.issueId;
    const values = new Map<string, string>([
      ["Agent Execution Lifecycle", PHASE49_AGENT_RUNNING],
      ["Agent Execution ID", handoff.executionId],
      ["Agent Exec Brief Revision", String(handoff.briefRevision)],
      ["Agent Exec Persisted Revision", handoff.persistedRevision],
      ["Agent Exec Req Fingerprint", handoff.requirementsFingerprint],
      ["Agent Execution Repository", handoff.repository],
      ["Agent Exec Source Revision", handoff.sourceRevision],
      ["Agent Execution Started At", "2026-09-21T03:00:00.000Z"],
      ["Agent Execution Finished At", ""],
      ["Agent Execution Outcome", ""],
      ["Agent Artifact Reference", ""],
    ]);
    this.#fields = [...values.entries()].map(([name, value], index) => ({
      id: 11 + index,
      name,
      value,
    }));
  }

  getIssue(issueId: number): Promise<RedmineIssueRecord> {
    assert.equal(issueId, this.#issueId);
    return Promise.resolve({
      id: this.#issueId,
      project: { id: 414, name: "Redmine" },
      tracker: { id: 2, name: "Feature" },
      subject: "Phase 49 fixture",
      description: "",
      customFields: this.#fields.map((field) => ({ ...field })),
      updatedOn: "2026-09-21T03:00:00Z",
      journals: [],
      relations: [],
      children: [],
    });
  }

  updateIssueCustomFields(issueId: number, writes: readonly CustomFieldWrite[]): Promise<void> {
    assert.equal(issueId, this.#issueId);
    this.writeCount += 1;
    this.#events.push("redmine-write");
    if (this.failWrites) {
      return Promise.reject(new Error("simulated Redmine write failure"));
    }
    for (const write of writes) {
      const target = this.#fields.find((field) => field.id === write.id);
      if (target === undefined) {
        return Promise.reject(new Error("unexpected custom field write"));
      }
      target.value = write.value;
    }
    this.afterWriteMutation?.();
    return Promise.resolve();
  }

  value(name: string): string {
    const field = this.#fields.find((entry) => entry.name === name);
    if (field === undefined) {
      throw new Error(`missing field: ${name}`);
    }
    return field.value;
  }

  setValue(name: string, value: string): void {
    const field = this.#fields.find((entry) => entry.name === name);
    if (field === undefined) {
      throw new Error(`missing field: ${name}`);
    }
    field.value = value;
  }
}

class FakeS3Client implements Phase49S3ObjectClient {
  readonly #artifact: Phase49BuiltArtifact;
  headOverride: Phase49S3ObjectObservation | undefined;

  constructor(artifact: Phase49BuiltArtifact) {
    this.#artifact = artifact;
  }

  putObject(_input: Phase49S3PutInput): Promise<void> {
    return Promise.resolve();
  }

  headObject(_input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation> {
    return Promise.resolve(this.headOverride ?? this.matchingObservation());
  }

  getObject(_input: Phase49S3GetInput): Promise<Phase49S3GetObservation> {
    return Promise.resolve({ ...this.matchingObservation(), body: this.#artifact.body });
  }

  matchingObservation(): Phase49S3ObjectObservation {
    return {
      checksumType: "FULL_OBJECT",
      checksumSha256Base64: this.#artifact.envelopeChecksumSha256Base64,
      metadata: { ...this.#artifact.metadata },
      serverSideEncryption: "AES256",
      versionId: undefined,
      contentLength: this.#artifact.sizeBytes,
    };
  }
}

function s3Config() {
  return Object.freeze({
    region: "ap-northeast-1",
    bucket: "phase49-artifacts-example",
    prefix: PHASE49_DEFAULT_S3_PREFIX,
    expectedBucketOwner: "123456789012",
  });
}

function changesReadyHandoff(): Phase49DevelopmentHandoffInput {
  return {
    executionId: EXECUTION_ID,
    issueId: 5421,
    repository: "mcp-mamono210/ai-agent-runner",
    sourceRevision: SOURCE_REVISION,
    briefRevision: 10,
    persistedRevision: "persisted-revision-10",
    requirementsFingerprint: FINGERPRINT,
    provisionalOutcome: "changes_ready",
    changedFiles: [{ path: "a.txt", status: "modified" }],
    localChangeSet: {
      patch: {
        text: CHANGES_PATCH,
        capturedBytes: Buffer.byteLength(CHANGES_PATCH, "utf8"),
        truncated: false,
      },
    },
  };
}

function noChangesHandoff(): Phase49DevelopmentHandoffInput {
  return {
    executionId: EXECUTION_ID,
    issueId: 5421,
    repository: "mcp-mamono210/ai-agent-runner",
    sourceRevision: SOURCE_REVISION,
    briefRevision: 10,
    persistedRevision: "persisted-revision-10",
    requirementsFingerprint: FINGERPRINT,
    provisionalOutcome: "no_changes",
    changedFiles: [],
    localChangeSet: {
      patch: {
        text: PHASE49_CANONICAL_EMPTY_PATCH,
        capturedBytes: 0,
        truncated: false,
      },
    },
  };
}

function assertStartedIdentityPreserved(
  redmine: InMemoryRedmineClient,
  handoff: Phase49DevelopmentHandoffInput,
): void {
  assert.equal(redmine.value("Agent Execution ID"), handoff.executionId);
  assert.equal(redmine.value("Agent Exec Brief Revision"), String(handoff.briefRevision));
  assert.equal(redmine.value("Agent Exec Persisted Revision"), handoff.persistedRevision);
  assert.equal(redmine.value("Agent Exec Req Fingerprint"), handoff.requirementsFingerprint);
  assert.equal(redmine.value("Agent Execution Repository"), handoff.repository);
  assert.equal(redmine.value("Agent Exec Source Revision"), handoff.sourceRevision);
  assert.equal(redmine.value("Agent Execution Started At"), "2026-09-21T03:00:00.000Z");
}
