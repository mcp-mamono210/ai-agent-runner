import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { AgentController } from "../../src/controller/controller.js";
import { InMemoryIssueLock } from "../../src/controller/local-lock.js";
import type {
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

const issue: ReFetchedIssue = {
  issueId: 9001,
  projectId: 414,
  lifecycle: "Ready for Agent",
  raw: { id: 9001 },
};

const handoff: ValidatedHandoff = {
  issueId: 9001,
  repository: "mcp-mamono210/example",
  approvedRequirementsFingerprint: `sha256:${"a".repeat(64)}`,
  opaque: { approved: true },
};

interface DependencyOverrides {
  candidateSource?: CandidateSource;
  issueReader?: IssueReader;
  handoffValidator?: HandoffValidator;
  requirementsRevalidator?: RequirementsRevalidator;
  rejectionWriter?: PreExecutionRejectionWriter;
  startupReconciler?: StartupReconciler;
  eligibleCandidateHandler?: EligibleCandidateHandler;
  sleeper?: Sleeper;
}

function buildDependencies(overrides: DependencyOverrides = {}) {
  return {
    candidateSource:
      overrides.candidateSource ??
      ({
        listReadyForAgentCandidates: mock.fn(() =>
          Promise.resolve([
            { issueId: issue.issueId, projectId: issue.projectId },
          ]),
        ),
      } satisfies CandidateSource),
    issueReader:
      overrides.issueReader ??
      ({ getIssue: mock.fn(() => Promise.resolve(issue)) } satisfies IssueReader),
    handoffValidator:
      overrides.handoffValidator ??
      ({
        validate: mock.fn(() =>
          Promise.resolve({ ok: true, handoff } as const),
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
  };
}

void describe("AgentController", () => {
  void it("polls only the configured project and Ready for Agent with limit=1", async () => {
    const calls: unknown[] = [];
    const candidateSource: CandidateSource = {
      listReadyForAgentCandidates: (input) => {
        calls.push(input);
        return Promise.resolve([]);
      },
    };
    const deps = buildDependencies({ candidateSource });
    const controller = new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    );

    await controller.runOnce();

    assert.deepEqual(calls, [
      {
        allowedProjectIds: [414],
        lifecycle: "Ready for Agent",
        limit: 1,
      },
    ]);
  });

  void it("re-fetches before reusing Phase 46 handoff and fingerprint validation ports", async () => {
    const order: string[] = [];
    const deps = buildDependencies({
      issueReader: {
        getIssue: () => {
          order.push("refetch");
          return Promise.resolve(issue);
        },
      },
      handoffValidator: {
        validate: () => {
          order.push("handoff");
          return Promise.resolve({ ok: true, handoff } as const);
        },
      },
      requirementsRevalidator: {
        revalidate: () => {
          order.push("requirements");
          return Promise.resolve({
            kind: "current" as const,
            currentFingerprint: handoff.approvedRequirementsFingerprint,
          });
        },
      },
      eligibleCandidateHandler: {
        handle: () => {
          order.push("eligible-handler");
          return Promise.resolve();
        },
      },
    });
    const controller = new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    );

    await controller.runOnce();

    assert.deepEqual(order, [
      "refetch",
      "handoff",
      "requirements",
      "eligible-handler",
    ]);
  });

  void it("rejects stale requirements as stale_requirements", async () => {
    const rejections: unknown[] = [];
    let eligibleHandled = false;
    const deps = buildDependencies({
      rejectionWriter: {
        reject: (input) => {
          rejections.push(input);
          return Promise.resolve();
        },
      },
      eligibleCandidateHandler: {
        handle: () => {
          eligibleHandled = true;
          return Promise.resolve();
        },
      },
      requirementsRevalidator: {
        revalidate: () =>
          Promise.resolve({
            kind: "stale" as const,
            currentFingerprint: `sha256:${"b".repeat(64)}`,
            approvedFingerprint: handoff.approvedRequirementsFingerprint,
          }),
      },
    });
    const controller = new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    );

    await controller.runOnce();

    assert.deepEqual(rejections, [
      {
        issueId: issue.issueId,
        outcome: "stale_requirements",
        diagnostic:
          "current requirements fingerprint does not match approved fingerprint",
      },
    ]);
    assert.equal(eligibleHandled, false);
  });

  void it("maps handoff validation failure to eligibility_failed", async () => {
    const rejections: unknown[] = [];
    const deps = buildDependencies({
      rejectionWriter: {
        reject: (input) => {
          rejections.push(input);
          return Promise.resolve();
        },
      },
      handoffValidator: {
        validate: () =>
          Promise.resolve({
            ok: false as const,
            diagnostic: "approval metadata incomplete",
          }),
      },
    });
    const controller = new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    );

    await controller.runOnce();

    assert.deepEqual(rejections, [
      {
        issueId: issue.issueId,
        outcome: "eligibility_failed",
        diagnostic: "approval metadata incomplete",
      },
    ]);
  });

  void it("maps requirements validation failure to eligibility_failed", async () => {
    const rejections: unknown[] = [];
    const deps = buildDependencies({
      rejectionWriter: {
        reject: (input) => {
          rejections.push(input);
          return Promise.resolve();
        },
      },
      requirementsRevalidator: {
        revalidate: () =>
          Promise.resolve({
            kind: "failed" as const,
            diagnostic: "fingerprint generation failed",
          }),
      },
    });
    const controller = new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    );

    await controller.runOnce();

    assert.deepEqual(rejections, [
      {
        issueId: issue.issueId,
        outcome: "eligibility_failed",
        diagnostic: "fingerprint generation failed",
      },
    ]);
  });

  void it("releases the local lock when downstream validation throws", async () => {
    const localLock = new InMemoryIssueLock();
    const deps = buildDependencies({
      handoffValidator: {
        validate: () => Promise.reject(new Error("temporary read failure")),
      },
    });
    const controller = new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      { ...deps, localLock },
    );

    await assert.rejects(controller.runOnce(), /temporary read failure/);
    assert.equal(localLock.isHeld(issue.issueId), false);
  });

  void it("does not process a candidate whose re-fetched lifecycle is no longer Ready for Agent", async () => {
    let handoffCalled = false;
    const deps = buildDependencies({
      issueReader: {
        getIssue: () => Promise.resolve({ ...issue, lifecycle: "Brief Ready" }),
      },
      handoffValidator: {
        validate: () => {
          handoffCalled = true;
          return Promise.resolve({ ok: true, handoff } as const);
        },
      },
    });
    const controller = new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    );

    await controller.runOnce();

    assert.equal(handoffCalled, false);
    assert.equal(deps.localLock.isHeld(issue.issueId), false);
  });

  void it("runs startup reconciliation before the first poll", async () => {
    const order: string[] = [];
    const abort = new AbortController();
    const deps = buildDependencies({
      startupReconciler: {
        reconcile: () => {
          order.push("reconcile");
          return Promise.resolve();
        },
      },
      candidateSource: {
        listReadyForAgentCandidates: () => {
          order.push("poll");
          abort.abort();
          return Promise.resolve([]);
        },
      },
      sleeper: {
        sleep: () => Promise.resolve(),
      },
    });
    const controller = new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    );

    await controller.run(abort.signal);

    assert.deepEqual(order, ["reconcile", "poll"]);
  });
  void it("does not begin polling when startup reconciliation remains unconfirmed", async () => {
    let polled = false;
    const deps = buildDependencies({
      startupReconciler: {
        reconcile: () => Promise.reject(new Error("reconciliation unconfirmed")),
      },
      candidateSource: {
        listReadyForAgentCandidates: () => {
          polled = true;
          return Promise.resolve([]);
        },
      },
    });
    const controller = new AgentController(
      { allowedProjectIds: [414], pollIntervalMs: 30_000 },
      deps,
    );

    await assert.rejects(controller.run(new AbortController().signal), /reconciliation unconfirmed/u);
    assert.equal(polled, false);
  });

});
