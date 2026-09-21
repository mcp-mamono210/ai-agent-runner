import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProvisionalAgentExecutionResult } from "../../src/agent/types.js";
import { Phase49ProvisionalResultHandler } from "../../src/artifact/phase49-provisional-handler.js";
import { AgentController } from "../../src/controller/controller.js";
import { InMemoryIssueLock } from "../../src/controller/local-lock.js";
import type {
  CandidateSource,
  HandoffValidator,
  IssueReader,
  PreExecutionRejectionWriter,
  ReFetchedIssue,
  RequirementsRevalidator,
  StartupReconciler,
  ValidatedHandoff,
} from "../../src/controller/types.js";
import { Phase47FormalAuthorizationGate } from "../../src/execution/formal-gate.js";
import { Phase48_3ExactSourceResolvedHandler } from "../../src/execution/preparation.js";
import type {
  FormalAuthorizationGate,
  PreparedExecution,
} from "../../src/execution/types.js";
import {
  GitCliRepositoryComponent,
  type GitCommandInput,
  type GitCommandRunner,
} from "../../src/repository/git-repository.js";
import { Phase48_2EligibleCandidateHandler } from "../../src/repository/phase48-2-handler.js";
import {
  RepositoryAccessPolicy,
  type RepositoryCredentialProvider,
} from "../../src/repository/policy.js";
import type {
  RepositoryAccessEntry,
  RepositoryCredential,
  RepositorySourceResolver,
} from "../../src/repository/types.js";
import { RedminePreExecutionRejectionWriter } from "../../src/redmine/rejection-writer.js";
import { RedmineRestClient } from "../../src/redmine/rest-client.js";
import type { RepositoryCheckoutResult } from "../../src/repository/types.js";
import type { TaskWorkspace } from "../../src/sandbox/types.js";
import {
  Phase50DeterministicHarness,
  type Phase50ScenarioValueMap,
} from "../../src/verification/phase50-harness.js";

const ISSUE_ID = 5427;
const PROJECT_ID = 414;
const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SOURCE_REVISION = "b".repeat(40);
const MUTATED_SOURCE_REVISION = "c".repeat(40);
const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const MUTATED_FINGERPRINT = `sha256:${"d".repeat(64)}`;
const REPOSITORY = "mcp-mamono210/ai-agent-runner";

const ENTRY: RepositoryAccessEntry = Object.freeze({
  repository: REPOSITORY,
  remoteUrl: "https://github.com/mcp-mamono210/ai-agent-runner.git",
  sourceRef: "refs/heads/main",
  usernameEnv: "GIT_USER",
  passwordEnv: "GIT_TOKEN",
});

const issue: ReFetchedIssue = Object.freeze({
  issueId: ISSUE_ID,
  projectId: PROJECT_ID,
  lifecycle: "Ready for Agent",
  raw: {},
});

function handoff(repository = REPOSITORY): ValidatedHandoff {
  return Object.freeze({
    issueId: ISSUE_ID,
    repository,
    approvedRequirementsFingerprint: FINGERPRINT,
    approval: Object.freeze({
      approverIdentity: "redmine-user:3",
      approvedAt: "2026-09-21T09:00:00Z",
      briefRevision: 7,
      persistedRevision: "persisted-brief-revision-7",
    }),
    opaque: {},
  });
}

class RecordingCredentialProvider implements RepositoryCredentialProvider {
  calls = 0;

  getCredential(_entry: RepositoryAccessEntry): RepositoryCredential {
    this.calls += 1;
    return { username: "reader", password: "secret" };
  }
}

class RecordingGitRunner implements GitCommandRunner {
  readonly calls: GitCommandInput[] = [];

  run(input: GitCommandInput): Promise<string> {
    this.calls.push(input);
    if (input.args[0] === "rev-parse") {
      return Promise.resolve(`${SOURCE_REVISION}\n`);
    }
    return Promise.resolve("");
  }
}

interface MutableField {
  readonly id: number;
  readonly name: string;
  value: string;
}

interface RejectionFixture {
  readonly writer: PreExecutionRejectionWriter;
  readonly fields: readonly MutableField[];
  putCount(): number;
}

function rejectionFixture(): RejectionFixture {
  const fields: MutableField[] = [
    { id: 11, name: "Agent Execution Lifecycle", value: "" },
    { id: 12, name: "Agent Rejection At", value: "" },
    { id: 13, name: "Agent Rejection Outcome", value: "" },
    { id: 14, name: "Agent Rejection Diagnostic", value: "" },
    { id: 15, name: "Agent Execution ID", value: "" },
  ];
  let writes = 0;

  const fakeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (!url.pathname.endsWith(`/issues/${ISSUE_ID}.json`)) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    if ((init?.method ?? "GET") === "PUT") {
      writes += 1;
      const body = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(body) as {
        issue: { custom_fields: Array<{ id: number; value: string }> };
      };
      for (const update of parsed.issue.custom_fields) {
        const field = fields.find((candidate) => candidate.id === update.id);
        if (field === undefined) {
          throw new Error("unexpected Phase 50-3 Redmine field write");
        }
        field.value = update.value;
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response(JSON.stringify(issuePayload(fields)), { status: 200 }));
  };

  const client = new RedmineRestClient({
    baseUrl: "https://redmine.example.test",
    readApiKey: "read-secret",
    writeApiKey: "write-secret",
    fetchImpl: fakeFetch,
  });
  return {
    writer: new RedminePreExecutionRejectionWriter({
      client,
      allowedProjectIds: [PROJECT_ID],
      clock: () => new Date("2026-09-21T09:10:00Z"),
    }),
    fields,
    putCount: () => writes,
  };
}

function issuePayload(fields: readonly MutableField[]): unknown {
  return {
    issue: {
      id: ISSUE_ID,
      project: { id: PROJECT_ID, name: "Redmine" },
      tracker: { id: 2, name: "Feature" },
      subject: "Phase 50-3 fixture",
      description: "Phase 50-3 fixture",
      updated_on: "2026-09-21T09:00:00Z",
      custom_fields: fields,
      journals: [],
      relations: [],
      children: [],
    },
  };
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

function fieldValue(fields: readonly MutableField[], name: string): string {
  const value = fields.find((field) => field.name === name)?.value;
  if (value === undefined) {
    throw new Error(`missing Phase 50-3 fixture field: ${name}`);
  }
  return value;
}

interface StartObservation {
  readonly allocated: number;
  readonly persisted: number;
  readonly agentStarted: number;
  readonly prepared?: PreparedExecution;
}

function executionPreparation(input: {
  readonly policy: RepositoryAccessPolicy;
  readonly rejectionWriter: PreExecutionRejectionWriter;
  readonly formalGate?: FormalAuthorizationGate;
}): {
  readonly handler: Phase48_3ExactSourceResolvedHandler;
  readonly observation: StartObservation;
} {
  const mutable: {
    allocated: number;
    persisted: number;
    agentStarted: number;
    prepared?: PreparedExecution;
  } = { allocated: 0, persisted: 0, agentStarted: 0 };

  const handler = new Phase48_3ExactSourceResolvedHandler({
    formalGate: input.formalGate ?? new Phase47FormalAuthorizationGate(input.policy),
    rejectionWriter: input.rejectionWriter,
    executionIdAllocator: {
      allocate: () => {
        mutable.allocated += 1;
        return EXECUTION_ID;
      },
    },
    agentRunningWriter: {
      persistAndConfirm: (execution) => {
        mutable.persisted += 1;
        mutable.prepared = execution;
        return Promise.resolve();
      },
    },
    next: {
      handle: () => {
        mutable.agentStarted += 1;
        return Promise.resolve();
      },
    },
    clock: () => new Date("2026-09-21T09:11:00Z"),
  });

  return {
    handler,
    get observation(): StartObservation {
      return Object.freeze({ ...mutable });
    },
  };
}

function authorizationConfiguration(
  scenario: Phase50ScenarioValueMap["SC-01"],
): { readonly repository: string; readonly policy: RepositoryAccessPolicy } {
  switch (scenario) {
    case "allow":
      return {
        repository: REPOSITORY,
        policy: new RepositoryAccessPolicy({ kind: "configured", entries: [ENTRY] }),
      };
    case "deny":
      return {
        repository: "mcp-mamono210/denied",
        policy: new RepositoryAccessPolicy({ kind: "configured", entries: [ENTRY] }),
      };
    case "unknown":
      return {
        repository: "mcp-mamono210/unknown",
        policy: new RepositoryAccessPolicy({ kind: "configured", entries: [] }),
      };
    case "invalid":
      return {
        repository: REPOSITORY,
        policy: new RepositoryAccessPolicy({
          kind: "invalid",
          diagnostic: "Phase 50-3 invalid authorization fixture",
        }),
      };
  }
}

void describe("Phase 50-3 authorization / snapshot immutability regression", () => {
  void it("runs SC-01 early allowlist before credentialed repository access and fails closed", async () => {
    for (const scenario of ["allow", "deny", "unknown", "invalid"] as const) {
      const harness = new Phase50DeterministicHarness();
      harness.scenarios.set("SC-01", scenario);
      const configuredScenario = harness.scenarios.require("SC-01");
      const authorization = authorizationConfiguration(configuredScenario);
      const credentials = new RecordingCredentialProvider();
      const git = new RecordingGitRunner();
      const rejections = rejectionFixture();
      const preparation = executionPreparation({
        policy: authorization.policy,
        rejectionWriter: rejections.writer,
      });
      const repository = new GitCliRepositoryComponent({
        policy: authorization.policy,
        credentialProvider: credentials,
        gitRunner: git,
      });
      const handler = new Phase48_2EligibleCandidateHandler({
        repository,
        rejectionWriter: rejections.writer,
        next: preparation.handler,
      });

      await handler.handle({
        issue,
        handoff: handoff(authorization.repository),
        currentRequirementsFingerprint: FINGERPRINT,
      });

      if (scenario === "allow") {
        assert.equal(credentials.calls, 1, scenario);
        assert.ok(git.calls.some((call) => call.args[0] === "fetch"), scenario);
        assert.equal(preparation.observation.allocated, 1, scenario);
        assert.equal(preparation.observation.persisted, 1, scenario);
        assert.equal(preparation.observation.agentStarted, 1, scenario);
        assert.equal(rejections.putCount(), 0, scenario);
        continue;
      }

      assert.equal(credentials.calls, 0, scenario);
      assert.equal(git.calls.length, 0, scenario);
      assert.equal(preparation.observation.allocated, 0, scenario);
      assert.equal(preparation.observation.persisted, 0, scenario);
      assert.equal(preparation.observation.agentStarted, 0, scenario);
      assert.equal(rejections.putCount(), 1, scenario);
      assert.equal(fieldValue(rejections.fields, "Agent Execution Lifecycle"), "Needs Human", scenario);
      assert.equal(fieldValue(rejections.fields, "Agent Rejection Outcome"), "eligibility_failed", scenario);
      assert.equal(fieldValue(rejections.fields, "Agent Execution ID"), "", scenario);
    }
  });

  void it("runs the formal gate after exact source fixation and before execution_id allocation", async () => {
    for (const scenario of ["allow", "deny", "unknown"] as const) {
      const rejections = rejectionFixture();
      const events: string[] = ["exact-source-fixed"];
      const repository = scenario === "unknown" ? "mcp-mamono210/unknown" : REPOSITORY;
      const policy = new RepositoryAccessPolicy({
        kind: "configured",
        entries: scenario === "deny" ? [] : [ENTRY],
      });
      const actualGate = new Phase47FormalAuthorizationGate(policy);
      const preparation = executionPreparation({
        policy,
        rejectionWriter: rejections.writer,
        formalGate: {
          authorize: async (input) => {
            events.push("formal-gate");
            await actualGate.authorize(input);
          },
        },
      });

      const originalAllocator = preparation.handler;
      await originalAllocator.handle({
        issue,
        handoff: handoff(repository),
        currentRequirementsFingerprint: FINGERPRINT,
        repository,
        sourceRevision: SOURCE_REVISION,
      });

      assert.deepEqual(events.slice(0, 2), ["exact-source-fixed", "formal-gate"], scenario);
      if (scenario === "allow") {
        assert.equal(preparation.observation.allocated, 1, scenario);
        assert.equal(preparation.observation.persisted, 1, scenario);
        assert.equal(preparation.observation.agentStarted, 1, scenario);
        assert.equal(rejections.putCount(), 0, scenario);
      } else {
        assert.equal(preparation.observation.allocated, 0, scenario);
        assert.equal(preparation.observation.persisted, 0, scenario);
        assert.equal(preparation.observation.agentStarted, 0, scenario);
        assert.equal(fieldValue(rejections.fields, "Agent Execution Lifecycle"), "Needs Human", scenario);
        assert.equal(fieldValue(rejections.fields, "Agent Rejection Outcome"), "eligibility_failed", scenario);
        assert.equal(fieldValue(rejections.fields, "Agent Execution ID"), "", scenario);
      }
    }
  });

  void it("uses FI-14 to fail closed at formal authorization without allocating execution_id", async () => {
    const harness = new Phase50DeterministicHarness();
    harness.scenarios.set("SC-01", "allow");
    harness.faults.arm("FI-14");
    const rejections = rejectionFixture();
    const policy = new RepositoryAccessPolicy({ kind: "configured", entries: [ENTRY] });
    const actualGate = new Phase47FormalAuthorizationGate(policy);
    let actualGateCalls = 0;
    const preparation = executionPreparation({
      policy,
      rejectionWriter: rejections.writer,
      formalGate: {
        authorize: async (input) => {
          await harness.formalAuthorizationGate();
          actualGateCalls += 1;
          await actualGate.authorize(input);
        },
      },
    });

    await preparation.handler.handle({
      issue,
      handoff: handoff(),
      currentRequirementsFingerprint: FINGERPRINT,
      repository: REPOSITORY,
      sourceRevision: SOURCE_REVISION,
    });

    assert.deepEqual(harness.faults.observed(), ["FI-14"]);
    assert.equal(actualGateCalls, 0);
    assert.equal(preparation.observation.allocated, 0);
    assert.equal(preparation.observation.persisted, 0);
    assert.equal(preparation.observation.agentStarted, 0);
    assert.equal(fieldValue(rejections.fields, "Agent Execution Lifecycle"), "Needs Human");
    assert.equal(fieldValue(rejections.fields, "Agent Rejection Outcome"), "eligibility_failed");
    assert.equal(fieldValue(rejections.fields, "Agent Execution ID"), "");
    assert.match(
      fieldValue(rejections.fields, "Agent Rejection Diagnostic"),
      /formal Phase 47 authorization failed/u,
    );
  });

  void it("keeps the started snapshot immutable across SC-04 / SC-05 / SC-06 and binds artifact identity to it", async () => {
    const harness = new Phase50DeterministicHarness();
    const rejections = rejectionFixture();
    let resolveCalls = 0;
    const resolver: RepositorySourceResolver = {
      resolveExactSource: (repository) => {
        resolveCalls += 1;
        return Promise.resolve({ repository, sourceRevision: SOURCE_REVISION });
      },
    };
    const policy = new RepositoryAccessPolicy({ kind: "configured", entries: [ENTRY] });
    const preparation = executionPreparation({
      policy,
      rejectionWriter: rejections.writer,
    });
    const handler = new Phase48_2EligibleCandidateHandler({
      repository: resolver,
      rejectionWriter: rejections.writer,
      next: preparation.handler,
    });

    await handler.handle({
      issue,
      handoff: handoff(),
      currentRequirementsFingerprint: FINGERPRINT,
    });

    const started = preparation.observation.prepared;
    if (started === undefined) {
      throw new Error("Phase 50-3 expected a prepared started execution");
    }
    assert.equal(resolveCalls, 1);
    assert.equal(Object.isFrozen(started), true);
    assert.equal(Object.isFrozen(started.input), true);
    assert.equal(Object.isFrozen(started.input.approvedBriefReference), true);

    harness.scenarios.set("SC-04", MUTATED_FINGERPRINT);
    harness.scenarios.set("SC-05", 99);
    harness.scenarios.set("SC-06", MUTATED_SOURCE_REVISION);
    harness.applyMutableScenarios();

    assert.equal(harness.redmine.snapshot().requirementsFingerprint, MUTATED_FINGERPRINT);
    assert.equal(harness.brief.currentRevision(), 99);
    assert.equal(harness.git.branchHead(), MUTATED_SOURCE_REVISION);

    let artifactHandoff:
      | {
          readonly executionId: string;
          readonly issueId: number;
          readonly repository: string;
          readonly sourceRevision: string;
          readonly briefRevision: number;
          readonly persistedRevision: string;
          readonly requirementsFingerprint: string;
        }
      | undefined;
    const artifactHandler = new Phase49ProvisionalResultHandler({
      collector: {
        collect: () => Promise.resolve({
          changedFiles: [{ path: "src/example.ts", status: "modified" }],
          patch: {
            text: "diff --git a/src/example.ts b/src/example.ts\n",
            capturedBytes: 48,
            truncated: false,
          },
        }),
      },
      finalization: {
        finalize: (input) => {
          artifactHandoff = input;
          return Promise.resolve({
            kind: "artifact_failure",
            redmine: {
              executionId: EXECUTION_ID,
              issueId: ISSUE_ID,
              lifecycle: "Needs Human",
              outcome: "artifact_persistence_failed",
              artifactReference: "",
              finishedAt: "2026-09-21T09:12:00.000Z",
            },
          });
        },
      },
    });

    await artifactHandler.handle({
      execution: started,
      result: provisionalResult(),
      workspace: workspace(),
      checkout: checkout(),
    });

    assert.equal(resolveCalls, 1, "source revision must not be re-resolved after execution start");
    if (artifactHandoff === undefined) {
      throw new Error("Phase 50-3 expected an artifact handoff");
    }
    assert.deepEqual(
      {
        executionId: artifactHandoff.executionId,
        issueId: artifactHandoff.issueId,
        repository: artifactHandoff.repository,
        sourceRevision: artifactHandoff.sourceRevision,
        briefRevision: artifactHandoff.briefRevision,
        persistedRevision: artifactHandoff.persistedRevision,
        requirementsFingerprint: artifactHandoff.requirementsFingerprint,
      },
      {
        executionId: EXECUTION_ID,
        issueId: ISSUE_ID,
        repository: REPOSITORY,
        sourceRevision: SOURCE_REVISION,
        briefRevision: 7,
        persistedRevision: "persisted-brief-revision-7",
        requirementsFingerprint: FINGERPRINT,
      },
    );
    assert.equal(started.input.sourceRevision, SOURCE_REVISION);
    assert.equal(started.input.briefRevision, 7);
    assert.equal(started.input.requirementsFingerprint, FINGERPRINT);
  });

  void it("prevents duplicate local execution without making the local lock a durable SoT", async () => {
    const lock = new InMemoryIssueLock();
    let handlerCalls = 0;
    let releaseFirst: (() => void) | undefined;
    let enteredFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const controller = new AgentController(
      { allowedProjectIds: [PROJECT_ID], pollIntervalMs: 30_000 },
      controllerDependencies(lock, {
        handle: () => {
          handlerCalls += 1;
          if (handlerCalls === 1) {
            enteredFirst?.();
            return firstRelease;
          }
          return Promise.resolve();
        },
      }),
    );

    const first = controller.runOnce();
    await firstEntered;
    assert.equal(lock.isHeld(ISSUE_ID), true);

    await controller.runOnce();
    assert.equal(handlerCalls, 1, "second local candidate must not enter while lock is held");

    releaseFirst?.();
    await first;
    assert.equal(lock.isHeld(ISSUE_ID), false);

    await controller.runOnce();
    assert.equal(handlerCalls, 2, "local execution can proceed after transient lock release");

    const afterProcessRestart = new InMemoryIssueLock();
    assert.equal(afterProcessRestart.isHeld(ISSUE_ID), false);
    assert.equal(afterProcessRestart.tryAcquire(ISSUE_ID), true);
  });
});

function workspace(): TaskWorkspace {
  return {
    executionId: EXECUTION_ID,
    path: "/tmp/phase50-3-workspace",
    diskLimitBytes: 1024,
    measureDiskUsageBytes: () => Promise.resolve(0),
    assertWithinDiskLimit: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
}

function checkout(): RepositoryCheckoutResult {
  return {
    repository: REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    targetDir: "/tmp/phase50-3-workspace",
    headRevision: SOURCE_REVISION,
  };
}

function provisionalResult(): ProvisionalAgentExecutionResult {
  return {
    kind: "provisional_success",
    outcome: "changes_ready",
    output: { text: "ok", capturedBytes: 2, truncated: false },
    diagnostic: { text: "", capturedBytes: 0, truncated: false },
  };
}

function controllerDependencies(
  localLock: InMemoryIssueLock,
  eligibleCandidateHandler: { handle(input: unknown): Promise<void> },
) {
  const candidateSource: CandidateSource = {
    listReadyForAgentCandidates: () =>
      Promise.resolve([{ issueId: ISSUE_ID, projectId: PROJECT_ID }]),
  };
  const issueReader: IssueReader = {
    getIssue: () => Promise.resolve(issue),
  };
  const handoffValidator: HandoffValidator = {
    validate: () => Promise.resolve({ ok: true, handoff: handoff() } as const),
  };
  const requirementsRevalidator: RequirementsRevalidator = {
    revalidate: () =>
      Promise.resolve({ kind: "current", currentFingerprint: FINGERPRINT } as const),
  };
  const rejectionWriter: PreExecutionRejectionWriter = {
    reject: () => Promise.reject(new Error("unexpected rejection")),
  };
  const startupReconciler: StartupReconciler = {
    reconcile: () => Promise.resolve(),
  };
  return {
    candidateSource,
    issueReader,
    handoffValidator,
    requirementsRevalidator,
    rejectionWriter,
    startupReconciler,
    eligibleCandidateHandler,
    localLock,
    sleeper: { sleep: () => Promise.resolve() },
  };
}
