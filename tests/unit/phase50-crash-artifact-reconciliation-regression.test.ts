import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPhase49Artifact } from "../../src/artifact/contract.js";
import {
  PHASE49_DEFAULT_S3_PREFIX,
  Phase49S3ArtifactPersistence,
  Phase49S3OperationError,
  type Phase49S3GetInput,
  type Phase49S3GetObservation,
  type Phase49S3HeadInput,
  type Phase49S3ObjectClient,
  type Phase49S3ObjectObservation,
  type Phase49S3PutInput,
} from "../../src/artifact/s3-persistence.js";
import { AgentController } from "../../src/controller/controller.js";
import { InMemoryIssueLock } from "../../src/controller/local-lock.js";
import { RedmineInterruptedExecutionFinalizer } from "../../src/redmine/interrupted-finalizer.js";
import {
  PHASE49_AGENT_RUNNING,
  PHASE49_NEEDS_HUMAN,
  PHASE49_READY_FOR_INDEPENDENT_VERIFICATION,
  RedminePhase49ExecutionFinalizer,
} from "../../src/redmine/phase49-finalizer.js";
import { RedmineRestClient } from "../../src/redmine/rest-client.js";
import { Phase49ArtifactAwareExecutionReconciler } from "../../src/recovery/phase49-artifact-reconciler.js";
import { Phase48_6StartupReconciler } from "../../src/recovery/startup-reconciler.js";
import { KnownSecretRedactor } from "../../src/security/redaction.js";
import {
  Phase50DeterministicHarness,
  Phase50InjectedFaultError,
} from "../../src/verification/phase50-harness.js";

const ISSUE_ID = 5430;
const PROJECT_ID = 414;
const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174001";
const REPOSITORY = "mcp-mamono210/ai-agent-runner";
const SOURCE_REVISION = "a".repeat(40);
const BRIEF_REVISION = 12;
const PERSISTED_REVISION = "persisted-revision-12";
const FINGERPRINT = `sha256:${"b".repeat(64)}`;
const STARTED_AT = "2026-09-21T12:30:00.000Z";
const FINISHED_AT = "2026-09-21T12:45:00.000Z";
const BUCKET = "phase50-recovery-example";
const PREFIX = PHASE49_DEFAULT_S3_PREFIX;
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

const FIELD_NAMES = [
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
] as const;

type Artifact = ReturnType<typeof buildPhase49Artifact>;
type S3Mode =
  | "normal"
  | "not-found"
  | "access-denied"
  | "unreadable"
  | "checksum-missing"
  | "metadata-undefined"
  | "metadata-null"
  | "metadata-value-missing"
  | "metadata-non-ascii"
  | "metadata-mismatch"
  | "envelope-checksum-mismatch"
  | "patch-checksum-mismatch"
  | "manifest-corrupt"
  | "unsupported-format"
  | "body-corrupt";

void describe("Phase 50-6 crash / artifact-aware reconciliation regression", () => {
  void it("runs cleanup before Agent Running reconciliation", async () => {
    const order: string[] = [];
    const startup = new Phase48_6StartupReconciler({
      cleaner: {
        cleanup: () => {
          order.push("cleanup");
          return Promise.resolve({ removedSandboxContainers: 1, removedWorkspaces: 1 });
        },
      },
      source: {
        listAgentRunningExecutions: () => {
          order.push("list-agent-running");
          return Promise.resolve([{ issueId: ISSUE_ID, projectId: PROJECT_ID }]);
        },
      },
      finalizer: {
        finalizeInterrupted: () => {
          order.push("reconcile");
          return Promise.resolve();
        },
      },
      redactor: new KnownSecretRedactor([]),
    });

    await startup.reconcile();

    assert.deepEqual(order, ["cleanup", "list-agent-running", "reconcile"]);
  });

  void it("stops reconciliation and normal polling when startup cleanup fails", async () => {
    let recoverySourceCalled = false;
    let polled = false;
    const startup = new Phase48_6StartupReconciler({
      cleaner: { cleanup: () => Promise.reject(new Error("owned cleanup failed")) },
      source: {
        listAgentRunningExecutions: () => {
          recoverySourceCalled = true;
          return Promise.resolve([]);
        },
      },
      finalizer: { finalizeInterrupted: () => Promise.resolve() },
      redactor: new KnownSecretRedactor([]),
    });
    const controller = new AgentController(
      { allowedProjectIds: [PROJECT_ID], pollIntervalMs: 30_000 },
      {
        startupReconciler: startup,
        candidateSource: {
          listReadyForAgentCandidates: () => {
            polled = true;
            return Promise.resolve([]);
          },
        },
        issueReader: { getIssue: () => Promise.reject(new Error("unexpected issue read")) },
        handoffValidator: { validate: () => Promise.reject(new Error("unexpected handoff")) },
        requirementsRevalidator: {
          revalidate: () => Promise.reject(new Error("unexpected requirements validation")),
        },
        rejectionWriter: { reject: () => Promise.reject(new Error("unexpected rejection")) },
        eligibleCandidateHandler: {
          handle: () => Promise.reject(new Error("unexpected eligible handling")),
        },
        localLock: new InMemoryIssueLock(),
        sleeper: { sleep: () => Promise.resolve() },
      },
    );

    await assert.rejects(
      controller.run(new AbortController().signal),
      /startup recovery cleanup failed: owned cleanup failed/u,
    );
    assert.equal(recoverySourceCalled, false);
    assert.equal(polled, false);
  });

  void it("converges Agent Running plus explicit artifact absence to interrupted / Needs Human", async () => {
    const backend = new DurableRedmineBackend(agentRunningFields());
    const client = redmineClient(backend);
    const reconciler = artifactAwareReconciler({
      backend,
      recovery: new Phase49S3ArtifactPersistence({
        client: new MatrixS3Client(undefined, "not-found"),
        config: s3Config(),
      }),
      absentArtifactFinalizer: new RedmineInterruptedExecutionFinalizer({
        client,
        allowedProjectIds: [PROJECT_ID],
        clock: () => new Date(FINISHED_AT),
      }),
    });

    await reconciler.finalizeInterrupted(ISSUE_ID);

    assert.equal(backend.value("Agent Execution Lifecycle"), PHASE49_NEEDS_HUMAN);
    assert.equal(backend.value("Agent Execution Outcome"), "interrupted");
    assert.equal(backend.value("Agent Artifact Reference"), "");
  });

  for (const outcome of ["changes_ready", "no_changes"] as const) {
    void it(`successfully reconciles Agent Running plus a valid ${outcome} artifact`, async () => {
      const artifact = artifactFixture(outcome);
      const backend = new DurableRedmineBackend(agentRunningFields());
      const client = redmineClient(backend);
      const reconciler = artifactAwareReconciler({
        backend,
        recovery: new Phase49S3ArtifactPersistence({
          client: new MatrixS3Client(artifact, "normal"),
          config: s3Config(),
        }),
        successFinalizer: new RedminePhase49ExecutionFinalizer({
          client,
          allowedProjectIds: [PROJECT_ID],
          clock: () => new Date(FINISHED_AT),
        }),
      });

      await reconciler.finalizeInterrupted(ISSUE_ID);

      assert.equal(
        backend.value("Agent Execution Lifecycle"),
        PHASE49_READY_FOR_INDEPENDENT_VERIFICATION,
      );
      assert.equal(backend.value("Agent Execution Outcome"), outcome);
      assert.match(backend.value("Agent Artifact Reference"), /^s3:\/\//u);
      if (outcome === "no_changes") {
        assert.notEqual(backend.value("Agent Artifact Reference"), "");
      }
    });
  }

  void it("uses only explicit not_found for the absence fallback and keeps access denial fail-closed", async () => {
    const backend = new DurableRedmineBackend(agentRunningFields());
    let absentFallbackCount = 0;
    const reconciler = artifactAwareReconciler({
      backend,
      recovery: new Phase49S3ArtifactPersistence({
        client: new MatrixS3Client(artifactFixture("changes_ready"), "access-denied"),
        config: s3Config(),
      }),
      absentArtifactFinalizer: {
        finalizeInterrupted: () => {
          absentFallbackCount += 1;
          return Promise.resolve();
        },
      },
    });

    await assert.rejects(
      reconciler.finalizeInterrupted(ISSUE_ID),
      (error: unknown) =>
        error instanceof Phase49S3OperationError &&
        error.kind === "access_denied" &&
        /access denied/u.test(error.message),
    );
    assert.equal(absentFallbackCount, 0);
    assert.equal(backend.value("Agent Execution Lifecycle"), PHASE49_AGENT_RUNNING);
  });

  void it("does not re-enter Agent Running reconciliation from finalized, Needs Human, or Ready for Agent states", async () => {
    for (const lifecycle of [
      PHASE49_READY_FOR_INDEPENDENT_VERIFICATION,
      PHASE49_NEEDS_HUMAN,
      "Ready for Agent",
    ] as const) {
      const fields = lifecycleFields(lifecycle);
      const backend = new DurableRedmineBackend(fields);
      let recoveryCount = 0;
      let successCount = 0;
      const reconciler = artifactAwareReconciler({
        backend,
        recovery: {
          recoverAndVerify: () => {
            recoveryCount += 1;
            return Promise.reject(new Error("artifact must not be read for non-Agent-Running state"));
          },
        },
        successFinalizer: {
          finalizeSuccess: () => {
            successCount += 1;
            return Promise.reject(new Error("must not refinalize"));
          },
        },
      });

      await assert.rejects(
        reconciler.finalizeInterrupted(ISSUE_ID),
        /Agent Execution Lifecycle/u,
      );
      assert.equal(recoveryCount, 0);
      assert.equal(successCount, 0);
      assert.equal(backend.value("Agent Execution Lifecycle"), lifecycle);
    }
  });

  void it("recovers failed started-failure finalization only from durable Redmine plus artifact absence", async () => {
    for (const historicalObservation of [
      "agent_failed",
      "timeout",
      "agent_start_failed",
    ] as const) {
      const backend = new DurableRedmineBackend(agentRunningFields());
      const client = redmineClient(backend);
      const reconciler = artifactAwareReconciler({
        backend,
        recovery: new Phase49S3ArtifactPersistence({
          client: new MatrixS3Client(undefined, "not-found"),
          config: s3Config(),
        }),
        absentArtifactFinalizer: new RedmineInterruptedExecutionFinalizer({
          client,
          allowedProjectIds: [PROJECT_ID],
          clock: () => new Date(FINISHED_AT),
        }),
      });

      await reconciler.finalizeInterrupted(ISSUE_ID);

      assert.equal(backend.value("Agent Execution Outcome"), "interrupted");
      assert.notEqual(backend.value("Agent Execution Outcome"), historicalObservation);
      assert.equal(backend.value("Agent Execution Lifecycle"), PHASE49_NEEDS_HUMAN);
    }
  });

  void it("consumes FI-06 as Agent Running plus artifact absent on restart", async () => {
    const harness = new Phase50DeterministicHarness();
    harness.faults.arm("FI-06");
    assert.throws(() => harness.checkpointAfterAgentResult(), Phase50InjectedFaultError);

    const backend = new DurableRedmineBackend(agentRunningFields());
    const client = redmineClient(backend);
    const reconciler = artifactAwareReconciler({
      backend,
      recovery: new Phase49S3ArtifactPersistence({ client: harness.s3, config: s3Config() }),
      absentArtifactFinalizer: new RedmineInterruptedExecutionFinalizer({
        client,
        allowedProjectIds: [PROJECT_ID],
        clock: () => new Date(FINISHED_AT),
      }),
    });

    await reconciler.finalizeInterrupted(ISSUE_ID);

    assert.deepEqual(harness.faults.observed(), ["FI-06"]);
    assert.equal(backend.value("Agent Execution Lifecycle"), PHASE49_NEEDS_HUMAN);
    assert.equal(backend.value("Agent Execution Outcome"), "interrupted");
  });

  void it("consumes FI-08 and adopts the remotely-created matching object in the same run", async () => {
    const harness = new Phase50DeterministicHarness();
    const artifact = artifactFixture("changes_ready");
    const persistence = new Phase49S3ArtifactPersistence({ client: harness.s3, config: s3Config() });
    harness.faults.arm("FI-08", {
      error: new Phase49S3OperationError("ambiguous", "simulated PutObject timeout after remote success"),
    });

    const persisted = await persistence.persistAndConfirm(artifact);

    assert.deepEqual(harness.faults.observed(), ["FI-08"]);
    assert.equal(persisted.adoptedExistingObject, true);
    assert.equal(
      harness.s3.hasObject(BUCKET, `${PREFIX}/${EXECUTION_ID}.json`),
      true,
    );
  });

  void it("consumes FI-09 and finalizes the already-durable artifact after restart", async () => {
    const harness = new Phase50DeterministicHarness();
    const artifact = artifactFixture("changes_ready");
    const persistence = new Phase49S3ArtifactPersistence({ client: harness.s3, config: s3Config() });
    await persistence.persistAndConfirm(artifact);

    harness.faults.arm("FI-09");
    assert.throws(() => harness.checkpointAfterArtifactPersistence(), Phase50InjectedFaultError);

    const backend = new DurableRedmineBackend(agentRunningFields());
    const client = redmineClient(backend);
    const reconciler = artifactAwareReconciler({
      backend,
      recovery: persistence,
      successFinalizer: new RedminePhase49ExecutionFinalizer({
        client,
        allowedProjectIds: [PROJECT_ID],
        clock: () => new Date(FINISHED_AT),
      }),
    });

    await reconciler.finalizeInterrupted(ISSUE_ID);

    assert.deepEqual(harness.faults.observed(), ["FI-09"]);
    assert.equal(
      backend.value("Agent Execution Lifecycle"),
      PHASE49_READY_FOR_INDEPENDENT_VERIFICATION,
    );
    assert.equal(backend.value("Agent Execution Outcome"), "changes_ready");
  });

  for (const faultId of ["FI-12", "FI-13"] as const) {
    void it(`keeps ${faultId} fail-closed instead of selecting artifact absence`, async () => {
      const harness = new Phase50DeterministicHarness();
      const artifact = artifactFixture("changes_ready");
      const persistence = new Phase49S3ArtifactPersistence({ client: harness.s3, config: s3Config() });
      await persistence.persistAndConfirm(artifact);
      harness.faults.arm(faultId);

      const backend = new DurableRedmineBackend(agentRunningFields());
      let absentFallbackCount = 0;
      const reconciler = artifactAwareReconciler({
        backend,
        recovery: persistence,
        absentArtifactFinalizer: {
          finalizeInterrupted: () => {
            absentFallbackCount += 1;
            return Promise.resolve();
          },
        },
      });

      await assert.rejects(
        reconciler.finalizeInterrupted(ISSUE_ID),
        (error: unknown) =>
          error instanceof Phase50InjectedFaultError && error.faultId === faultId,
      );
      assert.equal(absentFallbackCount, 0);
      assert.equal(backend.value("Agent Execution Lifecycle"), PHASE49_AGENT_RUNNING);
      assert.equal(backend.value("Agent Execution Outcome"), "");
    });
  }

  void it("keeps the durable started identity across SC-04 / SC-05 / SC-06 changes during restart", async () => {
    const harness = new Phase50DeterministicHarness();
    harness.scenarios.set("SC-04", `sha256:${"c".repeat(64)}`);
    harness.scenarios.set("SC-05", 99);
    harness.scenarios.set("SC-06", "d".repeat(40));
    harness.applyMutableScenarios();

    const artifact = artifactFixture("changes_ready");
    const s3 = new MatrixS3Client(artifact, "normal");
    const backend = new DurableRedmineBackend(agentRunningFields());
    const client = redmineClient(backend);
    const reconciler = artifactAwareReconciler({
      backend,
      recovery: new Phase49S3ArtifactPersistence({ client: s3, config: s3Config() }),
      successFinalizer: new RedminePhase49ExecutionFinalizer({
        client,
        allowedProjectIds: [PROJECT_ID],
        clock: () => new Date(FINISHED_AT),
      }),
    });

    await reconciler.finalizeInterrupted(ISSUE_ID);

    assert.equal(harness.redmine.snapshot().requirementsFingerprint, `sha256:${"c".repeat(64)}`);
    assert.equal(harness.brief.currentRevision(), 99);
    assert.equal(harness.git.branchHead(), "d".repeat(40));
    assert.equal(backend.value("Agent Exec Req Fingerprint"), FINGERPRINT);
    assert.equal(backend.value("Agent Exec Brief Revision"), String(BRIEF_REVISION));
    assert.equal(backend.value("Agent Exec Persisted Revision"), PERSISTED_REVISION);
    assert.equal(backend.value("Agent Exec Source Revision"), SOURCE_REVISION);
    assert.equal(backend.value("Agent Execution Repository"), REPOSITORY);
    assert.equal(
      backend.value("Agent Execution Lifecycle"),
      PHASE49_READY_FOR_INDEPENDENT_VERIFICATION,
    );
    assert.equal(s3.headCount, 1);
    assert.equal(s3.getCount, 1);
    assert.equal(s3.putCount, 0);
  });

  void it("consumes SC-07 and fails closed for a corrupt artifact body", async () => {
    const harness = new Phase50DeterministicHarness();
    const artifact = artifactFixture("changes_ready");
    const persistence = new Phase49S3ArtifactPersistence({ client: harness.s3, config: s3Config() });
    await persistence.persistAndConfirm(artifact);
    harness.scenarios.set("SC-07", "body-corrupt");

    const backend = new DurableRedmineBackend(agentRunningFields());
    const reconciler = artifactAwareReconciler({ backend, recovery: persistence });

    await assert.rejects(reconciler.finalizeInterrupted(ISSUE_ID), /valid JSON|canonical/u);
    assert.equal(backend.value("Agent Execution Lifecycle"), PHASE49_AGENT_RUNNING);
    assert.equal(backend.value("Agent Execution Outcome"), "");
  });

  void it("asserts category-specific reasons for invalid or unverifiable artifacts", async () => {
    const base = artifactFixture("changes_ready");
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly artifact?: Artifact;
      readonly mode: S3Mode;
      readonly expected: RegExp;
    }> = [
      { name: "checksum missing", artifact: base, mode: "checksum-missing", expected: /ChecksumSHA256 is missing/u },
      { name: "metadata undefined", artifact: base, mode: "metadata-undefined", expected: /metadata projection is missing/u },
      { name: "metadata null", artifact: base, mode: "metadata-null", expected: /metadata projection is missing/u },
      { name: "metadata required value missing", artifact: base, mode: "metadata-value-missing", expected: /required metadata is missing/u },
      { name: "invalid metadata representation", artifact: base, mode: "metadata-non-ascii", expected: /metadata is not ASCII-safe/u },
      { name: "metadata mismatch", artifact: base, mode: "metadata-mismatch", expected: /metadata mismatch/u },
      { name: "metadata manifest mismatch", artifact: base, mode: "metadata-mismatch", expected: /metadata mismatch/u },
      { name: "artifact envelope checksum mismatch", artifact: base, mode: "envelope-checksum-mismatch", expected: /envelope checksum mismatch/u },
      { name: "patch checksum mismatch", artifact: base, mode: "patch-checksum-mismatch", expected: /patch checksum mismatch/u },
      { name: "manifest corruption", artifact: base, mode: "manifest-corrupt", expected: /artifact manifest must be an object/u },
      { name: "unsupported format", artifact: base, mode: "unsupported-format", expected: /format version is unsupported/u },
      { name: "unreadable object", artifact: base, mode: "unreadable", expected: /unreadable object/u },
      { name: "access denied", artifact: base, mode: "access-denied", expected: /access denied/u },
      { name: "body corruption", artifact: base, mode: "body-corrupt", expected: /body is not valid JSON/u },
      {
        name: "source revision mismatch",
        artifact: artifactFixture("changes_ready", { sourceRevision: "c".repeat(40) }),
        mode: "normal",
        expected: /identity does not match Agent Running execution/u,
      },
      {
        name: "Brief identity mismatch",
        artifact: artifactFixture("changes_ready", { briefRevision: BRIEF_REVISION + 1 }),
        mode: "normal",
        expected: /identity does not match Agent Running execution/u,
      },
      {
        name: "requirements fingerprint mismatch",
        artifact: artifactFixture("changes_ready", { requirementsFingerprint: `sha256:${"e".repeat(64)}` }),
        mode: "normal",
        expected: /identity does not match Agent Running execution/u,
      },
      {
        name: "execution id mismatch",
        artifact: artifactFixture("changes_ready", { executionId: OTHER_EXECUTION_ID }),
        mode: "normal",
        expected: /identity does not match Agent Running execution/u,
      },
      {
        name: "issue id mismatch",
        artifact: artifactFixture("changes_ready", { issueId: ISSUE_ID + 1 }),
        mode: "normal",
        expected: /identity does not match Agent Running execution/u,
      },
    ];

    for (const testCase of cases) {
      const backend = new DurableRedmineBackend(agentRunningFields());
      let successCount = 0;
      let absentFallbackCount = 0;
      const reconciler = artifactAwareReconciler({
        backend,
        recovery: new Phase49S3ArtifactPersistence({
          client: new MatrixS3Client(testCase.artifact, testCase.mode),
          config: s3Config(),
        }),
        successFinalizer: {
          finalizeSuccess: () => {
            successCount += 1;
            return Promise.reject(new Error("unexpected successful reconciliation"));
          },
        },
        absentArtifactFinalizer: {
          finalizeInterrupted: () => {
            absentFallbackCount += 1;
            return Promise.resolve();
          },
        },
      });

      await assert.rejects(
        reconciler.finalizeInterrupted(ISSUE_ID),
        (error: unknown) =>
          error instanceof Error &&
          testCase.expected.test(error.message),
        testCase.name,
      );
      assert.equal(successCount, 0, testCase.name);
      assert.equal(absentFallbackCount, 0, testCase.name);
      assert.equal(backend.value("Agent Execution Lifecycle"), PHASE49_AGENT_RUNNING, testCase.name);
      assert.equal(backend.value("Agent Execution Outcome"), "", testCase.name);
    }
  });

  void it("recovers from deterministic identity without original workspace, local patch, or ListBucket", async () => {
    const artifact = artifactFixture("changes_ready");
    const s3 = new MatrixS3Client(artifact, "normal");
    const persistence = new Phase49S3ArtifactPersistence({ client: s3, config: s3Config() });

    const recovered = await persistence.recoverAndVerify({
      executionId: EXECUTION_ID,
      issueId: ISSUE_ID,
      repository: REPOSITORY,
      sourceRevision: SOURCE_REVISION,
      briefRevision: BRIEF_REVISION,
      persistedRevision: PERSISTED_REVISION,
      requirementsFingerprint: FINGERPRINT,
    });

    assert.equal(recovered.artifact.manifest.executionId, EXECUTION_ID);
    assert.equal(s3.putCount, 0);
    assert.equal(s3.headCount, 1);
    assert.equal(s3.getCount, 1);
    assert.equal(s3.listCount, 0);
  });
});

function artifactAwareReconciler(input: {
  readonly backend: DurableRedmineBackend;
  readonly recovery: ConstructorParameters<typeof Phase49ArtifactAwareExecutionReconciler>[0]["recovery"];
  readonly successFinalizer?: ConstructorParameters<typeof Phase49ArtifactAwareExecutionReconciler>[0]["successFinalizer"];
  readonly absentArtifactFinalizer?: ConstructorParameters<typeof Phase49ArtifactAwareExecutionReconciler>[0]["absentArtifactFinalizer"];
}): Phase49ArtifactAwareExecutionReconciler {
  return new Phase49ArtifactAwareExecutionReconciler({
    reader: { getIssue: () => Promise.resolve(input.backend.issueRecord()) },
    allowedProjectIds: [PROJECT_ID],
    recovery: input.recovery,
    successFinalizer: input.successFinalizer ?? {
      finalizeSuccess: () => Promise.reject(new Error("unexpected successful reconciliation")),
    },
    absentArtifactFinalizer: input.absentArtifactFinalizer ?? {
      finalizeInterrupted: () => Promise.reject(new Error("unexpected absence fallback")),
    },
  });
}

function s3Config() {
  return Object.freeze({
    region: "ap-northeast-1",
    bucket: BUCKET,
    prefix: PREFIX,
    expectedBucketOwner: "123456789012",
  });
}

function artifactFixture(
  outcome: "changes_ready" | "no_changes",
  overrides: Partial<{
    executionId: string;
    issueId: number;
    repository: string;
    sourceRevision: string;
    briefRevision: number;
    persistedRevision: string;
    requirementsFingerprint: string;
  }> = {},
): Artifact {
  const patch = outcome === "changes_ready" ? PATCH : "";
  return buildPhase49Artifact({
    executionId: overrides.executionId ?? EXECUTION_ID,
    issueId: overrides.issueId ?? ISSUE_ID,
    repository: overrides.repository ?? REPOSITORY,
    sourceRevision: overrides.sourceRevision ?? SOURCE_REVISION,
    briefRevision: overrides.briefRevision ?? BRIEF_REVISION,
    persistedRevision: overrides.persistedRevision ?? PERSISTED_REVISION,
    requirementsFingerprint: overrides.requirementsFingerprint ?? FINGERPRINT,
    outcome,
    changedFiles: outcome === "changes_ready" ? [{ path: "a.txt", status: "modified" }] : [],
    patch: {
      text: patch,
      capturedBytes: Buffer.byteLength(patch, "utf8"),
      truncated: false,
    },
  });
}

class MatrixS3Client implements Phase49S3ObjectClient {
  readonly #artifact: Artifact | undefined;
  readonly #mode: S3Mode;
  putCount = 0;
  headCount = 0;
  getCount = 0;
  listCount = 0;

  constructor(artifact: Artifact | undefined, mode: S3Mode) {
    this.#artifact = artifact;
    this.#mode = mode;
  }

  putObject(_input: Phase49S3PutInput): Promise<void> {
    this.putCount += 1;
    return Promise.reject(new Error("MatrixS3Client does not support persistence in recovery tests"));
  }

  headObject(_input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation> {
    this.headCount += 1;
    if (this.#mode === "not-found" || this.#artifact === undefined) {
      return Promise.reject(new Phase49S3OperationError("not_found", "explicit not_found"));
    }
    if (this.#mode === "access-denied") {
      return Promise.reject(new Phase49S3OperationError("access_denied", "access denied"));
    }
    return Promise.resolve(this.#observation());
  }

  getObject(_input: Phase49S3GetInput): Promise<Phase49S3GetObservation> {
    this.getCount += 1;
    if (this.#artifact === undefined) {
      return Promise.reject(new Phase49S3OperationError("not_found", "explicit not_found"));
    }
    if (this.#mode === "unreadable") {
      return Promise.reject(new Phase49S3OperationError("definitive", "unreadable object"));
    }
    return Promise.resolve({
      ...this.#observation(),
      body: this.#body(),
    });
  }

  #observation(): Phase49S3ObjectObservation {
    const artifact = this.#requiredArtifact();
    const metadata: Record<string, string | undefined> = { ...artifact.metadata };
    if (this.#mode === "metadata-value-missing") {
      metadata["source-revision"] = undefined;
    }
    if (this.#mode === "metadata-non-ascii") {
      metadata.repository = "répository";
    }
    if (this.#mode === "metadata-mismatch") {
      metadata.repository = "corrupt/repository";
    }
    return Object.freeze({
      checksumType: "FULL_OBJECT",
      checksumSha256Base64:
        this.#mode === "checksum-missing"
          ? undefined
          : this.#mode === "envelope-checksum-mismatch"
            ? Buffer.from("wrong-checksum", "utf8").toString("base64")
            : artifact.envelopeChecksumSha256Base64,
      metadata:
        this.#mode === "metadata-undefined"
          ? undefined
          : this.#mode === "metadata-null"
            ? null
            : Object.freeze(metadata),
      serverSideEncryption: "AES256",
      versionId: undefined,
      contentLength: artifact.sizeBytes,
    });
  }

  #body(): Uint8Array {
    const artifact = this.#requiredArtifact();
    if (this.#mode === "body-corrupt") {
      return Buffer.from("{", "utf8");
    }
    if (
      this.#mode !== "patch-checksum-mismatch" &&
      this.#mode !== "manifest-corrupt" &&
      this.#mode !== "unsupported-format"
    ) {
      return Uint8Array.from(artifact.body);
    }

    const document = JSON.parse(Buffer.from(artifact.body).toString("utf8")) as {
      manifest: Record<string, unknown> | null;
      patch: string;
    };
    if (this.#mode === "patch-checksum-mismatch") {
      document.patch = `${document.patch}tampered`;
    } else if (this.#mode === "manifest-corrupt") {
      document.manifest = null;
    } else {
      if (document.manifest === null) {
        throw new Error("fixture manifest unexpectedly null");
      }
      document.manifest.artifactFormatVersion = "unsupported.phase50";
    }
    return Buffer.from(JSON.stringify(document), "utf8");
  }

  #requiredArtifact(): Artifact {
    if (this.#artifact === undefined) {
      throw new Error("MatrixS3Client artifact is absent");
    }
    return this.#artifact;
  }
}

interface MutableField {
  readonly id: number;
  readonly name: string;
  value: string;
}

class DurableRedmineBackend {
  readonly #fields: MutableField[];
  writeCount = 0;

  constructor(fields: MutableField[]) {
    this.#fields = fields;
  }

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = input instanceof URL
      ? input
      : new URL(typeof input === "string" ? input : input.url);
    if (!url.pathname.endsWith(`/issues/${ISSUE_ID}.json`)) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    if ((init?.method ?? "GET") === "PUT") {
      this.writeCount += 1;
      const raw = typeof init?.body === "string" ? init.body : "";
      const payload = JSON.parse(raw) as {
        issue: { custom_fields: Array<{ id: number; value: string }> };
      };
      for (const write of payload.issue.custom_fields) {
        const field = this.#fields.find((candidate) => candidate.id === write.id);
        if (field === undefined) {
          return Promise.reject(new Error(`unexpected Redmine custom field id: ${write.id}`));
        }
        field.value = write.value;
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ issue: this.#issuePayload() }), { status: 200 }),
    );
  }

  issueRecord() {
    return {
      id: ISSUE_ID,
      project: { id: PROJECT_ID, name: "Redmine" },
      tracker: { id: 2, name: "Feature" },
      subject: "Phase 50-6 fixture",
      description: "",
      customFields: this.#fields.map((field) => ({ ...field })),
      updatedOn: STARTED_AT,
      journals: [],
      relations: [],
      children: [],
    };
  }

  value(name: string): string {
    const field = this.#fields.find((candidate) => candidate.name === name);
    if (field === undefined) {
      throw new Error(`missing fixture field: ${name}`);
    }
    return field.value;
  }

  #issuePayload() {
    return {
      id: ISSUE_ID,
      project: { id: PROJECT_ID, name: "Redmine" },
      tracker: { id: 2, name: "Feature" },
      subject: "Phase 50-6 fixture",
      description: "",
      updated_on: STARTED_AT,
      custom_fields: this.#fields.map((field) => ({ ...field })),
      journals: [],
      relations: [],
      children: [],
    };
  }
}

function redmineClient(backend: DurableRedmineBackend): RedmineRestClient {
  return new RedmineRestClient({
    baseUrl: "https://redmine.example.test",
    readApiKey: "read-key",
    writeApiKey: "write-key",
    fetchImpl: (input, init) => backend.fetch(input, init),
  });
}

function agentRunningFields(): MutableField[] {
  return fieldsFromValues(new Map<string, string>([
    ["Agent Execution Lifecycle", PHASE49_AGENT_RUNNING],
    ["Agent Execution ID", EXECUTION_ID],
    ["Agent Exec Brief Revision", String(BRIEF_REVISION)],
    ["Agent Exec Persisted Revision", PERSISTED_REVISION],
    ["Agent Exec Req Fingerprint", FINGERPRINT],
    ["Agent Execution Repository", REPOSITORY],
    ["Agent Exec Source Revision", SOURCE_REVISION],
    ["Agent Execution Started At", STARTED_AT],
    ["Agent Execution Finished At", ""],
    ["Agent Execution Outcome", ""],
    ["Agent Artifact Reference", ""],
  ]));
}

function lifecycleFields(
  lifecycle: typeof PHASE49_READY_FOR_INDEPENDENT_VERIFICATION | typeof PHASE49_NEEDS_HUMAN | "Ready for Agent",
): MutableField[] {
  const fields = agentRunningFields();
  const values = new Map(fields.map((field) => [field.name, field.value]));
  values.set("Agent Execution Lifecycle", lifecycle);
  if (lifecycle === PHASE49_READY_FOR_INDEPENDENT_VERIFICATION) {
    values.set("Agent Execution Finished At", FINISHED_AT);
    values.set("Agent Execution Outcome", "changes_ready");
    values.set("Agent Artifact Reference", `s3://${BUCKET}/${PREFIX}/${EXECUTION_ID}.json`);
  } else if (lifecycle === PHASE49_NEEDS_HUMAN) {
    values.set("Agent Execution Finished At", FINISHED_AT);
    values.set("Agent Execution Outcome", "interrupted");
  } else {
    for (const name of FIELD_NAMES.slice(1)) {
      values.set(name, "");
    }
  }
  return fieldsFromValues(values);
}

function fieldsFromValues(values: Map<string, string>): MutableField[] {
  return FIELD_NAMES.map((name, index) => ({
    id: 11 + index,
    name,
    value: values.get(name) ?? "",
  }));
}
