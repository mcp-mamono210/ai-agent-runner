import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { AgentController } from "../../src/controller/controller.js";
import { InMemoryIssueLock } from "../../src/controller/local-lock.js";
import type {
  CandidateDiagnosticSink,
  CandidateSource,
  EligibleCandidateHandler,
  HandoffValidator,
  IssueReader,
  PreExecutionRejectionWriter,
  ReFetchedIssue,
  RequirementsRevalidator,
  Sleeper,
  StartupReconciler,
  ValidatedHandoff,
} from "../../src/controller/types.js";

const handoff: ValidatedHandoff = {
  issueId: 9002,
  repository: "ansible-roles-mamono210/php",
  approvedRequirementsFingerprint: `sha256:${"a".repeat(64)}`,
  opaque: { approved: true },
};

function readyIssue(issueId: number, projectId = 414): ReFetchedIssue {
  return {
    issueId,
    projectId,
    lifecycle: "Ready for Agent",
    postLockState: {
      executionLifecycle: "",
      executionRecordPristine: true,
    },
    raw: { id: issueId },
  };
}

interface DependencyOverrides {
  candidateSource?: CandidateSource;
  issueReader?: IssueReader;
  handoffValidator?: HandoffValidator;
  requirementsRevalidator?: RequirementsRevalidator;
  rejectionWriter?: PreExecutionRejectionWriter;
  startupReconciler?: StartupReconciler;
  eligibleCandidateHandler?: EligibleCandidateHandler;
  sleeper?: Sleeper;
  candidateDiagnosticSink?: CandidateDiagnosticSink;
}

function buildDependencies(overrides: DependencyOverrides = {}) {
  return {
    candidateSource:
      overrides.candidateSource ??
      ({
        listReadyForAgentCandidates: mock.fn(() =>
          Promise.resolve([{ issueId: 9002, projectId: 414 }]),
        ),
      } satisfies CandidateSource),
    issueReader:
      overrides.issueReader ??
      ({ getIssue: mock.fn((issueId: number) => Promise.resolve(readyIssue(issueId))) } satisfies IssueReader),
    handoffValidator:
      overrides.handoffValidator ??
      ({
        validate: mock.fn((issue: ReFetchedIssue) =>
          Promise.resolve({
            ok: true,
            handoff: { ...handoff, issueId: issue.issueId },
          } as const),
        ),
      } satisfies HandoffValidator),
    requirementsRevalidator:
      overrides.requirementsRevalidator ??
      ({
        revalidate: mock.fn(() =>
          Promise.resolve({
            kind: "current" as const,
            currentFingerprint: handoff.approvedRequirementsFingerprint,
          }),
        ),
      } satisfies RequirementsRevalidator),
    rejectionWriter:
      overrides.rejectionWriter ??
      ({ reject: mock.fn(() => Promise.resolve()) } satisfies PreExecutionRejectionWriter),
    startupReconciler:
      overrides.startupReconciler ??
      ({ reconcile: mock.fn(() => Promise.resolve()) } satisfies StartupReconciler),
    eligibleCandidateHandler:
      overrides.eligibleCandidateHandler ??
      ({ handle: mock.fn(() => Promise.resolve()) } satisfies EligibleCandidateHandler),
    localLock: new InMemoryIssueLock(),
    sleeper:
      overrides.sleeper ??
      ({ sleep: mock.fn(() => Promise.resolve()) } satisfies Sleeper),
    ...(overrides.candidateDiagnosticSink === undefined
      ? {}
      : { candidateDiagnosticSink: overrides.candidateDiagnosticSink }),
  };
}

void describe("Phase 53 candidate scan regressions", () => {
  void it("skips a non-pristine lower-ID candidate with a bounded diagnostic and selects the later eligible Issue", async () => {
    const diagnostics: unknown[] = [];
    const handled: number[] = [];
    const deps = buildDependencies({
      candidateSource: {
        listReadyForAgentCandidates: () => Promise.resolve([
          { issueId: 9001, projectId: 414 },
          { issueId: 9002, projectId: 414 },
        ]),
      },
      issueReader: {
        getIssue: (issueId) => Promise.resolve(
          issueId === 9001
            ? {
                ...readyIssue(9001),
                postLockState: {
                  executionLifecycle: "",
                  executionRecordPristine: false,
                },
              }
            : readyIssue(issueId),
        ),
      },
      candidateDiagnosticSink: {
        record: (input) => {
          diagnostics.push(input);
          return Promise.resolve();
        },
      },
      eligibleCandidateHandler: {
        handle: (input) => {
          handled.push(input.issue.issueId);
          return Promise.resolve();
        },
      },
    });

    await new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    ).runOnce();

    assert.deepEqual(handled, [9002]);
    assert.deepEqual(diagnostics, [
      {
        kind: "non_pristine_candidate_skipped",
        issueId: 9001,
        reason: "post-lock execution or rejection record is non-pristine",
      },
    ]);
  });

  void it("treats post-lock project change as a skippable race and performs no write for the changed Issue", async () => {
    const diagnostics: unknown[] = [];
    const rejected: number[] = [];
    const handled: number[] = [];
    const deps = buildDependencies({
      candidateSource: {
        listReadyForAgentCandidates: () => Promise.resolve([
          { issueId: 9001, projectId: 414 },
          { issueId: 9002, projectId: 414 },
        ]),
      },
      issueReader: {
        getIssue: (issueId) => Promise.resolve(
          issueId === 9001 ? readyIssue(9001, 413) : readyIssue(issueId),
        ),
      },
      candidateDiagnosticSink: {
        record: (input) => {
          diagnostics.push(input);
          return Promise.resolve();
        },
      },
      rejectionWriter: {
        reject: (input) => {
          rejected.push(input.issueId);
          return Promise.resolve();
        },
      },
      eligibleCandidateHandler: {
        handle: (input) => {
          handled.push(input.issue.issueId);
          return Promise.resolve();
        },
      },
    });

    await new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    ).runOnce();

    assert.deepEqual(rejected, []);
    assert.deepEqual(handled, [9002]);
    assert.deepEqual(diagnostics, [
      {
        kind: "unexpected_project",
        issueId: 9001,
        reason: "post-lock issue project changed",
      },
    ]);
  });

  void it("treats post-lock lifecycle change separately from a list predicate mismatch and continues the scan", async () => {
    const diagnostics: unknown[] = [];
    const handled: number[] = [];
    const deps = buildDependencies({
      candidateSource: {
        listReadyForAgentCandidates: () => Promise.resolve([
          { issueId: 9001, projectId: 414 },
          { issueId: 9002, projectId: 414 },
        ]),
      },
      issueReader: {
        getIssue: (issueId) => Promise.resolve(
          issueId === 9001
            ? { ...readyIssue(9001), lifecycle: "Brief Ready" }
            : readyIssue(issueId),
        ),
      },
      candidateDiagnosticSink: {
        record: (input) => {
          diagnostics.push(input);
          return Promise.resolve();
        },
      },
      eligibleCandidateHandler: {
        handle: (input) => {
          handled.push(input.issue.issueId);
          return Promise.resolve();
        },
      },
    });

    await new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    ).runOnce();

    assert.deepEqual(handled, [9002]);
    assert.deepEqual(diagnostics, [
      {
        kind: "candidate_state_changed",
        issueId: 9001,
        reason: "post-lock brief lifecycle changed",
      },
    ]);
  });


  void it("skips a candidate whose execution lifecycle changes after the list response", async () => {
    const diagnostics: unknown[] = [];
    const handled: number[] = [];
    const deps = buildDependencies({
      candidateSource: {
        listReadyForAgentCandidates: () => Promise.resolve([
          { issueId: 9001, projectId: 414 },
          { issueId: 9002, projectId: 414 },
        ]),
      },
      issueReader: {
        getIssue: (issueId) => Promise.resolve(
          issueId === 9001
            ? {
                ...readyIssue(9001),
                postLockState: {
                  executionLifecycle: "Agent Running",
                  executionRecordPristine: false,
                },
              }
            : readyIssue(issueId),
        ),
      },
      candidateDiagnosticSink: {
        record: (input) => {
          diagnostics.push(input);
          return Promise.resolve();
        },
      },
      eligibleCandidateHandler: {
        handle: (input) => {
          handled.push(input.issue.issueId);
          return Promise.resolve();
        },
      },
    });

    await new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    ).runOnce();

    assert.deepEqual(handled, [9002]);
    assert.deepEqual(diagnostics, [
      {
        kind: "candidate_state_changed",
        issueId: 9001,
        reason: "post-lock execution lifecycle changed",
      },
    ]);
  });

  void it("skips a completed lower-ID candidate and never invokes it a second time", async () => {
    const diagnostics: unknown[] = [];
    const handled: number[] = [];
    const deps = buildDependencies({
      candidateSource: {
        listReadyForAgentCandidates: () => Promise.resolve([
          { issueId: 9001, projectId: 414 },
          { issueId: 9002, projectId: 414 },
        ]),
      },
      issueReader: {
        getIssue: (issueId) => Promise.resolve(
          issueId === 9001
            ? {
                ...readyIssue(9001),
                postLockState: {
                  executionLifecycle: "Ready for Independent Verification",
                  executionRecordPristine: false,
                },
              }
            : readyIssue(issueId),
        ),
      },
      candidateDiagnosticSink: {
        record: (input) => {
          diagnostics.push(input);
          return Promise.resolve();
        },
      },
      eligibleCandidateHandler: {
        handle: (input) => {
          handled.push(input.issue.issueId);
          return Promise.resolve();
        },
      },
    });

    await new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    ).runOnce();

    assert.deepEqual(handled, [9002]);
    assert.equal(handled.includes(9001), false);
    assert.deepEqual(diagnostics, [
      {
        kind: "candidate_state_changed",
        issueId: 9001,
        reason: "post-lock execution lifecycle changed",
      },
    ]);
  });

  void it("skips a Needs Human lower-ID candidate and selects the later eligible Issue", async () => {
    const diagnostics: unknown[] = [];
    const handled: number[] = [];
    const deps = buildDependencies({
      candidateSource: {
        listReadyForAgentCandidates: () => Promise.resolve([
          { issueId: 9001, projectId: 414 },
          { issueId: 9002, projectId: 414 },
        ]),
      },
      issueReader: {
        getIssue: (issueId) => Promise.resolve(
          issueId === 9001
            ? {
                ...readyIssue(9001),
                postLockState: {
                  executionLifecycle: "Needs Human",
                  executionRecordPristine: false,
                },
              }
            : readyIssue(issueId),
        ),
      },
      candidateDiagnosticSink: {
        record: (input) => {
          diagnostics.push(input);
          return Promise.resolve();
        },
      },
      eligibleCandidateHandler: {
        handle: (input) => {
          handled.push(input.issue.issueId);
          return Promise.resolve();
        },
      },
    });

    await new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    ).runOnce();

    assert.deepEqual(handled, [9002]);
    assert.deepEqual(diagnostics, [
      {
        kind: "candidate_state_changed",
        issueId: 9001,
        reason: "post-lock execution lifecycle changed",
      },
    ]);
  });

  void it("stops polling with candidate_scan_exhausted after 100 skippable candidates and never invokes the Agent handler", async () => {
    const diagnostics: unknown[] = [];
    let handled = false;
    let slept = false;
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      issueId: 10_000 + index,
      projectId: 414,
    }));
    const deps = buildDependencies({
      candidateSource: {
        listReadyForAgentCandidates: (input) => {
          assert.equal(input.limit, 100);
          return Promise.resolve(candidates);
        },
      },
      issueReader: {
        getIssue: (issueId) => Promise.resolve({
          ...readyIssue(issueId),
          postLockState: {
            executionLifecycle: "",
            executionRecordPristine: false,
          },
        }),
      },
      candidateDiagnosticSink: {
        record: (input) => {
          diagnostics.push(input);
          return Promise.resolve();
        },
      },
      eligibleCandidateHandler: {
        handle: () => {
          handled = true;
          return Promise.resolve();
        },
      },
      sleeper: {
        sleep: () => {
          slept = true;
          return Promise.resolve();
        },
      },
    });
    const controller = new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    );

    await assert.rejects(
      controller.run(new AbortController().signal),
      /candidate scan exhausted/u,
    );

    assert.equal(handled, false);
    assert.equal(slept, false);
    assert.equal(diagnostics.length, 101);
    assert.deepEqual(diagnostics.at(-1), {
      kind: "candidate_scan_exhausted",
      reason: "candidate scan bound reached without an executable candidate",
    });
  });
});
