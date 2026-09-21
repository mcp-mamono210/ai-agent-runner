import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CodexCliAgentAdapter } from "../../src/agent/codex-cli-adapter.js";
import {
  Phase48_5SandboxPreparationFailureHandler,
  Phase48_5SandboxPreparedHandler,
} from "../../src/agent/phase48-5-handler.js";
import {
  STARTED_EXECUTION_FAILURE_OUTCOMES,
  type CodexOneShotRunner,
  type CodexProcessObservation,
} from "../../src/agent/types.js";
import { PHASE49_CANONICAL_FAILURE_OUTCOME } from "../../src/artifact/contract.js";
import {
  Phase49SuccessfulFinalizationCoordinator,
  type Phase49ExecutionFinalizationPort,
} from "../../src/artifact/phase49-finalization.js";
import {
  PHASE49_DEFAULT_S3_PREFIX,
  Phase49S3ArtifactPersistence,
  phase49ArtifactObjectKey,
} from "../../src/artifact/s3-persistence.js";
import { AgentController } from "../../src/controller/controller.js";
import { InMemoryIssueLock } from "../../src/controller/local-lock.js";
import {
  PRE_EXECUTION_REJECTION_OUTCOMES,
  type ReFetchedIssue,
  type ValidatedHandoff,
} from "../../src/controller/types.js";
import type { PreparedExecution } from "../../src/execution/types.js";
import { RedmineStartedExecutionFailureFinalizer } from "../../src/redmine/execution-finalizer.js";
import { RedminePhase49ExecutionFinalizer } from "../../src/redmine/phase49-finalizer.js";
import { RedminePreExecutionRejectionWriter } from "../../src/redmine/rejection-writer.js";
import { RedmineRestClient } from "../../src/redmine/rest-client.js";
import type { RepositoryCheckout } from "../../src/repository/types.js";
import { Phase48_4AgentRunningConfirmedHandler } from "../../src/sandbox/phase48-4-handler.js";
import type {
  SandboxDisposalReason,
  SandboxHandle,
  SandboxRuntime,
  TaskWorkspace,
} from "../../src/sandbox/types.js";
import { TaskWorkspaceManager } from "../../src/sandbox/workspace.js";
import { KnownSecretRedactor } from "../../src/security/redaction.js";
import {
  Phase50DeterministicHarness,
  Phase50InjectedFaultError,
  type Phase50FaultId,
} from "../../src/verification/phase50-harness.js";

const ISSUE_ID = 5428;
const PROJECT_ID = 414;
const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const REPOSITORY = "mcp-mamono210/ai-agent-runner";
const SOURCE_REVISION = "b".repeat(40);
const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const STARTED_AT = "2026-09-21T10:10:00.000Z";
const FINISHED_AT = "2026-09-21T10:11:00.000Z";

const handoff: ValidatedHandoff = Object.freeze({
  issueId: ISSUE_ID,
  repository: REPOSITORY,
  approvedRequirementsFingerprint: FINGERPRINT,
  approval: Object.freeze({
    approverIdentity: "redmine-user:3",
    approvedAt: "2026-09-21T10:00:00Z",
    briefRevision: 8,
    persistedRevision: "persisted-brief-revision-8",
  }),
  opaque: {},
});

function preparedExecution(): PreparedExecution {
  const pending = Object.freeze({ kind: "pending" }) satisfies { readonly kind: "pending" };
  const approvedBriefReference = Object.freeze({
    repository: REPOSITORY,
    issueId: ISSUE_ID,
    briefRevision: 8,
    persistedRevision: "persisted-brief-revision-8",
  });
  const input = Object.freeze({
    executionId: EXECUTION_ID,
    issueId: ISSUE_ID,
    repository: REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    briefRevision: 8,
    persistedRevision: "persisted-brief-revision-8",
    requirementsFingerprint: FINGERPRINT,
    approvedBriefReference,
  });
  return Object.freeze({
    issue: Object.freeze({
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      lifecycle: "Agent Running",
      raw: {},
    }),
    handoff,
    input,
    record: Object.freeze({
      executionId: EXECUTION_ID,
      issueId: ISSUE_ID,
      briefRevision: 8,
      persistedRevision: "persisted-brief-revision-8",
      requirementsFingerprint: FINGERPRINT,
      repository: REPOSITORY,
      sourceRevision: SOURCE_REVISION,
      startedAt: STARTED_AT,
      finishedAt: pending,
      outcome: pending,
      artifactReference: pending,
    }),
  });
}

interface MutableField {
  readonly id: number;
  readonly name: string;
  value: string;
}

class RedmineFixture {
  readonly fields: MutableField[];
  readonly client: RedmineRestClient;
  putCount = 0;

  constructor(mode: "ready" | "running", execution = preparedExecution()) {
    const running = mode === "running";
    const values = new Map<string, string>([
      ["Agent Execution Lifecycle", running ? "Agent Running" : "Ready for Agent"],
      ["Agent Rejection At", ""],
      ["Agent Rejection Outcome", ""],
      ["Agent Rejection Diagnostic", ""],
      ["Agent Execution ID", running ? execution.input.executionId : ""],
      ["Agent Exec Brief Revision", running ? String(execution.input.briefRevision) : ""],
      ["Agent Exec Persisted Revision", running ? execution.input.persistedRevision : ""],
      ["Agent Exec Req Fingerprint", running ? execution.input.requirementsFingerprint : ""],
      ["Agent Execution Repository", running ? execution.input.repository : ""],
      ["Agent Exec Source Revision", running ? execution.input.sourceRevision : ""],
      ["Agent Execution Started At", running ? execution.record.startedAt : ""],
      ["Agent Execution Finished At", ""],
      ["Agent Execution Outcome", ""],
      ["Agent Artifact Reference", ""],
    ]);
    this.fields = [...values.entries()].map(([name, value], index) => ({
      id: 11 + index,
      name,
      value,
    }));

    const fakeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.pathname.endsWith(`/issues/${ISSUE_ID}.json`)) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if ((init?.method ?? "GET") === "PUT") {
        this.putCount += 1;
        const body = typeof init?.body === "string" ? init.body : "";
        const parsed = JSON.parse(body) as {
          issue: { custom_fields: Array<{ id: number; value: string }> };
        };
        for (const update of parsed.issue.custom_fields) {
          const target = this.fields.find((field) => field.id === update.id);
          if (target === undefined) {
            throw new Error("unexpected Phase 50-4 Redmine field write");
          }
          target.value = update.value;
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(this.issuePayload()), { status: 200 }),
      );
    };

    this.client = new RedmineRestClient({
      baseUrl: "https://redmine.example.test",
      readApiKey: "read-secret",
      writeApiKey: "write-secret",
      fetchImpl: fakeFetch,
    });
  }

  value(name: string): string {
    const value = this.fields.find((field) => field.name === name)?.value;
    if (value === undefined) {
      throw new Error(`missing Phase 50-4 fixture field: ${name}`);
    }
    return value;
  }


  private issuePayload(): unknown {
    return {
      issue: {
        id: ISSUE_ID,
        project: { id: PROJECT_ID, name: "Redmine" },
        tracker: { id: 2, name: "Feature" },
        subject: "Phase 50-4 fixture",
        description: "Phase 50-4 fixture",
        updated_on: "2026-09-21T10:00:00Z",
        custom_fields: this.fields,
        journals: [],
        relations: [],
        children: [],
      },
    };
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

class FaultInjectingCodexRunner implements CodexOneShotRunner {
  readonly #harness: Phase50DeterministicHarness;
  readonly #faultId: "FI-03" | "FI-04" | "FI-05";
  calls = 0;

  constructor(
    harness: Phase50DeterministicHarness,
    faultId: "FI-03" | "FI-04" | "FI-05",
  ) {
    this.#harness = harness;
    this.#faultId = faultId;
  }

  async run(): Promise<CodexProcessObservation> {
    this.calls += 1;
    try {
      await this.#harness.faults.around(this.#faultId, () => Promise.resolve());
    } catch (error) {
      if (!(error instanceof Phase50InjectedFaultError)) {
        throw error;
      }
      return observationFor(this.#faultId);
    }
    throw new Error(`Phase 50-4 fault was not injected: ${this.#faultId}`);
  }
}

function observationFor(
  faultId: "FI-03" | "FI-04" | "FI-05",
): CodexProcessObservation {
  const output = Object.freeze({ text: "", capturedBytes: 0, truncated: false });
  const diagnostic = Object.freeze({
    text: `deterministic ${faultId}`,
    capturedBytes: Buffer.byteLength(`deterministic ${faultId}`, "utf8"),
    truncated: false,
  });
  switch (faultId) {
    case "FI-03":
      return Object.freeze({ kind: "start_failed", output, diagnostic });
    case "FI-04":
      return Object.freeze({ kind: "completed", exitCode: 1, output, diagnostic });
    case "FI-05":
      return Object.freeze({ kind: "aborted", reason: "execution_timeout", output, diagnostic });
  }
}

class RecordingSandboxRuntime implements SandboxRuntime {
  disposalReasons: SandboxDisposalReason[] = [];
  workspacePath: string | undefined;

  create(input: {
    readonly execution: PreparedExecution;
    readonly workspace: TaskWorkspace;
  }): Promise<SandboxHandle> {
    this.workspacePath = input.workspace.path;
    const resources = Object.freeze({
      executionTimeoutMs: 1000,
      outputCaptureBytes: 1024,
      diagnosticCaptureBytes: 1024,
      workspaceDiskBytes: input.workspace.diskLimitBytes,
      containerLifecycleMs: 2000,
      workspaceCheckIntervalMs: 100,
      tmpfsBytes: 1024,
    });
    return Promise.resolve({
      containerId: "c".repeat(64),
      executionId: input.execution.input.executionId,
      workspace: input.workspace,
      resources,
      enforcementSignal: new AbortController().signal,
      inspectIsolation: () => Promise.resolve({
        containerId: "c".repeat(64),
        workspaceSource: input.workspace.path,
        workspaceDestination: "/workspace",
        networkName: "phase50-4-fixture",
        policyDigest: `sha256:${"d".repeat(64)}`,
      }),
      dispose: async (reason) => {
        this.disposalReasons.push(reason);
        await input.workspace.dispose();
      },
    });
  }
}

async function runStartedFailure(
  faultId: "FI-03" | "FI-04" | "FI-05",
  expectedOutcome: "agent_start_failed" | "agent_failed" | "timeout",
  expectedDisposal: SandboxDisposalReason,
): Promise<void> {
  const harness = new Phase50DeterministicHarness();
  harness.faults.arm(faultId);
  const execution = preparedExecution();
  const redmine = new RedmineFixture("running", execution);
  const finalizer = new RedmineStartedExecutionFailureFinalizer({
    client: redmine.client,
    allowedProjectIds: [PROJECT_ID],
    clock: () => new Date(FINISHED_AT),
  });
  const runner = new FaultInjectingCodexRunner(harness, faultId);
  const agentAdapter = new CodexCliAgentAdapter({
    credentialProvider: { getCredential: () => ({ apiKey: "fixture-provider-secret" }) },
    runner,
    redactor: new KnownSecretRedactor(["fixture-provider-secret"]),
    changeDetector: { hasChanges: () => Promise.resolve(false) },
  });
  let provisionalCalls = 0;
  const phase48_5 = new Phase48_5SandboxPreparedHandler({
    agentAdapter,
    failureFinalizer: finalizer,
    provisionalResultHandler: {
      handle: () => {
        provisionalCalls += 1;
        return Promise.resolve();
      },
    },
  });
  const root = await mkdtemp(join(tmpdir(), "phase50-4-workspace-root-"));
  const sandbox = new RecordingSandboxRuntime();
  const repository: RepositoryCheckout = {
    checkout: (input) => Promise.resolve({
      repository: input.repository,
      sourceRevision: input.sourceRevision,
      targetDir: input.targetDir,
      headRevision: input.sourceRevision,
    }),
  };
  const phase48_4 = new Phase48_4AgentRunningConfirmedHandler({
    workspaceManager: new TaskWorkspaceManager({ root, diskLimitBytes: 1024 * 1024 }),
    repository,
    sandboxRuntime: sandbox,
    next: phase48_5,
    preAgentFailureHandler: new Phase48_5SandboxPreparationFailureHandler(finalizer),
  });

  try {
    assert.equal(redmine.value("Agent Execution Lifecycle"), "Agent Running");
    assert.equal(redmine.value("Agent Execution ID"), EXECUTION_ID);

    await phase48_4.handle(execution);

    assert.deepEqual(harness.faults.observed(), [faultId]);
    assert.equal(runner.calls, 1, "automatic Agent retry must remain disabled");
    assert.equal(redmine.putCount, 1, "started failure uses one durable finalization write");
    assert.equal(redmine.value("Agent Execution Lifecycle"), "Needs Human");
    assert.equal(redmine.value("Agent Execution Outcome"), expectedOutcome);
    assert.equal(redmine.value("Agent Artifact Reference"), "");
    assert.equal(redmine.value("Agent Execution ID"), EXECUTION_ID);
    assert.equal(redmine.value("Agent Exec Source Revision"), SOURCE_REVISION);
    assert.notEqual(redmine.value("Agent Execution Lifecycle"), "Ready for Independent Verification");
    assert.equal(provisionalCalls, 0);
    assert.deepEqual(sandbox.disposalReasons, [expectedDisposal]);
    if (sandbox.workspacePath === undefined) {
      throw new Error("Phase 50-4 sandbox fixture did not observe a workspace");
    }
    await assert.rejects(stat(sandbox.workspacePath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function artifactHandoff(execution = preparedExecution()) {
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-before",
    "+after",
    "",
  ].join("\n");
  return Object.freeze({
    executionId: execution.input.executionId,
    issueId: execution.input.issueId,
    repository: execution.input.repository,
    sourceRevision: execution.input.sourceRevision,
    briefRevision: execution.input.briefRevision,
    persistedRevision: execution.input.persistedRevision,
    requirementsFingerprint: execution.input.requirementsFingerprint,
    provisionalOutcome: "changes_ready" as const,
    changedFiles: Object.freeze([{ path: "a.txt", status: "modified" as const }]),
    localChangeSet: Object.freeze({
      patch: Object.freeze({
        text: patch,
        capturedBytes: Buffer.byteLength(patch, "utf8"),
        truncated: false,
      }),
    }),
  });
}

void describe("Phase 50-4 execution failure outcome regression", () => {
  void it("keeps stale_requirements as a pre-execution rejection without execution identity", async () => {
    const redmine = new RedmineFixture("ready");
    const rejectionWriter = new RedminePreExecutionRejectionWriter({
      client: redmine.client,
      allowedProjectIds: [PROJECT_ID],
      clock: () => new Date("2026-09-21T10:05:00Z"),
    });
    let agentStarts = 0;
    const readyIssue: ReFetchedIssue = Object.freeze({
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      lifecycle: "Ready for Agent",
      raw: {},
    });
    const controller = new AgentController(
      { allowedProjectIds: [PROJECT_ID], pollIntervalMs: 30_000 },
      {
        candidateSource: {
          listReadyForAgentCandidates: () =>
            Promise.resolve([{ issueId: ISSUE_ID, projectId: PROJECT_ID }]),
        },
        issueReader: { getIssue: () => Promise.resolve(readyIssue) },
        handoffValidator: {
          validate: () => Promise.resolve({ ok: true as const, handoff }),
        },
        requirementsRevalidator: {
          revalidate: () => Promise.resolve({
            kind: "stale" as const,
            currentFingerprint: `sha256:${"c".repeat(64)}`,
            approvedFingerprint: FINGERPRINT,
            diagnostic: "requirements fingerprint changed after approval",
          }),
        },
        rejectionWriter,
        startupReconciler: { reconcile: () => Promise.resolve() },
        eligibleCandidateHandler: {
          handle: () => {
            agentStarts += 1;
            return Promise.resolve();
          },
        },
        localLock: new InMemoryIssueLock(),
        sleeper: { sleep: () => Promise.resolve() },
      },
    );

    await controller.runOnce();

    assert.equal(redmine.putCount, 1);
    assert.equal(redmine.value("Agent Execution Lifecycle"), "Needs Human");
    assert.equal(redmine.value("Agent Rejection Outcome"), "stale_requirements");
    assert.equal(
      redmine.value("Agent Rejection Diagnostic"),
      "requirements fingerprint changed after approval",
    );
    assert.equal(redmine.value("Agent Execution ID"), "");
    assert.equal(redmine.value("Agent Execution Outcome"), "");
    assert.equal(redmine.value("Agent Artifact Reference"), "");
    assert.equal(agentStarts, 0);
  });

  void it("uses FI-03 for Agent start failure and durably finalizes agent_start_failed", async () => {
    await runStartedFailure("FI-03", "agent_start_failed", "failure");
  });

  void it("uses FI-04 for Agent execution failure and durably finalizes agent_failed", async () => {
    await runStartedFailure("FI-04", "agent_failed", "failure");
  });

  void it("uses FI-05 for deterministic timeout and cleans sandbox/workspace after durable timeout", async () => {
    await runStartedFailure("FI-05", "timeout", "timeout");
  });

  void it("uses FI-07 for definite PutObject failure and durably finalizes artifact_persistence_failed", async () => {
    const harness = new Phase50DeterministicHarness();
    harness.faults.arm("FI-07");
    const execution = preparedExecution();
    const handoffValue = artifactHandoff(execution);
    const redmine = new RedmineFixture("running", execution);
    const config = Object.freeze({
      region: "ap-northeast-1",
      bucket: "phase50-4-artifacts-example",
      prefix: PHASE49_DEFAULT_S3_PREFIX,
      expectedBucketOwner: "123456789012",
    });
    const realFinalizer = new RedminePhase49ExecutionFinalizer({
      client: redmine.client,
      allowedProjectIds: [PROJECT_ID],
      clock: () => new Date(FINISHED_AT),
    });
    let failureReason: string | undefined;
    const finalizer: Phase49ExecutionFinalizationPort = {
      finalizeSuccess: (input) => realFinalizer.finalizeSuccess(input),
      finalizeArtifactFailure: (input) => {
        failureReason = input.reason;
        return realFinalizer.finalizeArtifactFailure(input);
      },
    };
    const persistence = new Phase49S3ArtifactPersistence({
      client: harness.s3,
      config,
    });
    const coordinator = new Phase49SuccessfulFinalizationCoordinator({
      persistence,
      finalizer,
    });

    const result = await coordinator.finalize(handoffValue);

    assert.equal(result.kind, "artifact_failure");
    assert.deepEqual(harness.faults.observed(), ["FI-07"]);
    assert.equal(failureReason, "storage_failure");
    assert.equal(redmine.putCount, 1);
    assert.equal(redmine.value("Agent Execution Lifecycle"), "Needs Human");
    assert.equal(redmine.value("Agent Execution Outcome"), "artifact_persistence_failed");
    assert.equal(redmine.value("Agent Artifact Reference"), "");
    assert.equal(redmine.value("Agent Execution ID"), EXECUTION_ID);
    assert.notEqual(redmine.value("Agent Execution Lifecycle"), "Ready for Independent Verification");
    const key = phase49ArtifactObjectKey(config, EXECUTION_ID);
    assert.equal(harness.s3.hasObject(config.bucket, key), false);
  });

  void it("keeps Phase 50-4 scope and the canonical outcome taxonomy unchanged", async () => {
    const baseline = JSON.parse(
      await readFile(join(process.cwd(), "docs/contracts/phase50-contract-baseline.json"), "utf8"),
    ) as { executionOutcomes: string[] };
    const matrix = JSON.parse(
      await readFile(join(process.cwd(), "docs/contracts/phase50-verification-matrix.json"), "utf8"),
    ) as { faults: Record<string, string[]> };

    assert.deepEqual(baseline.executionOutcomes, [
      "changes_ready",
      "no_changes",
      "stale_requirements",
      "eligibility_failed",
      "interrupted",
      "timeout",
      "agent_start_failed",
      "agent_failed",
      "artifact_persistence_failed",
    ]);
    assert.deepEqual(PRE_EXECUTION_REJECTION_OUTCOMES, [
      "stale_requirements",
      "eligibility_failed",
    ]);
    assert.deepEqual(STARTED_EXECUTION_FAILURE_OUTCOMES, [
      "timeout",
      "agent_start_failed",
      "agent_failed",
    ]);
    assert.equal(PHASE49_CANONICAL_FAILURE_OUTCOME, "artifact_persistence_failed");

    for (const id of ["FI-03", "FI-04", "FI-05", "FI-07"] satisfies Phase50FaultId[]) {
      assert.deepEqual(matrix.faults[id], ["50-4"]);
    }
    assert.deepEqual(matrix.faults["FI-10"], ["50-5"]);
    assert.deepEqual(matrix.faults["FI-11"], ["50-5"]);
    for (const id of ["FI-06", "FI-08", "FI-09"] satisfies Phase50FaultId[]) {
      assert.deepEqual(matrix.faults[id], ["50-6"]);
    }
    assert.deepEqual(matrix.faults["FI-12"], ["50-6", "50-7"]);
    assert.deepEqual(matrix.faults["FI-13"], ["50-6", "50-7"]);
  });
});
