import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  Phase48_5SandboxPreparationFailureHandler,
  Phase48_5SandboxPreparedHandler,
} from "../../src/agent/phase48-5-handler.js";
import {
  STARTED_FAILURE_RECONCILIATION_FALLBACK,
  type AgentExecutionResult,
} from "../../src/agent/types.js";
import type { PreparedExecution } from "../../src/execution/types.js";
import type { PreparedSandboxExecution } from "../../src/sandbox/types.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";

function execution(): PreparedExecution {
  const pending = Object.freeze({ kind: "pending" }) satisfies { readonly kind: "pending" };
  const reference = Object.freeze({
    repository: "mcp-mamono210/redmine",
    issueId: 5414,
    briefRevision: 1,
    persistedRevision: "persisted",
  });
  const input = Object.freeze({
    executionId: EXECUTION_ID,
    issueId: 5414,
    repository: reference.repository,
    sourceRevision: "a".repeat(40),
    briefRevision: 1,
    persistedRevision: "persisted",
    requirementsFingerprint: `sha256:${"b".repeat(64)}`,
    approvedBriefReference: reference,
  });
  return Object.freeze({
    issue: { issueId: 5414, projectId: 414, lifecycle: "Ready for Agent", raw: {} },
    handoff: {
      issueId: 5414,
      repository: input.repository,
      approvedRequirementsFingerprint: input.requirementsFingerprint,
      opaque: {},
    },
    input,
    record: Object.freeze({
      executionId: input.executionId,
      issueId: input.issueId,
      briefRevision: input.briefRevision,
      persistedRevision: input.persistedRevision,
      requirementsFingerprint: input.requirementsFingerprint,
      repository: input.repository,
      sourceRevision: input.sourceRevision,
      startedAt: "2026-09-19T00:00:00.000Z",
      finishedAt: pending,
      outcome: pending,
      artifactReference: pending,
    }),
  });
}

function prepared(): PreparedSandboxExecution {
  const current = execution();
  const workspace = {
    executionId: EXECUTION_ID,
    path: "/tmp/workspace",
    diskLimitBytes: 1024,
    measureDiskUsageBytes: () => Promise.resolve(0),
    assertWithinDiskLimit: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
  return {
    execution: current,
    workspace,
    checkout: {
      repository: current.input.repository,
      sourceRevision: current.input.sourceRevision,
      targetDir: workspace.path,
      headRevision: current.input.sourceRevision,
    },
    sandbox: {
      containerId: "c".repeat(64),
      executionId: EXECUTION_ID,
      workspace,
      resources: {
        executionTimeoutMs: 1000,
        outputCaptureBytes: 100,
        diagnosticCaptureBytes: 100,
        workspaceDiskBytes: 1024,
        containerLifecycleMs: 2000,
        workspaceCheckIntervalMs: 100,
        tmpfsBytes: 1024,
      },
      enforcementSignal: new AbortController().signal,
      inspectIsolation: () => Promise.resolve({
        containerId: "c".repeat(64),
        workspaceSource: workspace.path,
        workspaceDestination: "/workspace",
        networkName: "network",
        policyDigest: `sha256:${"d".repeat(64)}`,
      }),
      dispose: () => Promise.resolve(),
    },
  };
}

function result(outcome: AgentExecutionResult["outcome"]): AgentExecutionResult {
  const capture = { text: "bounded", capturedBytes: 7, truncated: false };
  if (outcome === "changes_ready" || outcome === "no_changes") {
    return { kind: "provisional_success", outcome, output: capture, diagnostic: capture };
  }
  return { kind: "started_failure", outcome, output: capture, diagnostic: capture };
}

void describe("Phase 48-5 one-shot result routing", () => {
  void it("durably finalizes timeout and returns timeout disposal without provisional success", async () => {
    const finalized: string[] = [];
    let provisionalCalled = false;
    const handler = new Phase48_5SandboxPreparedHandler({
      agentAdapter: { runAgent: () => Promise.resolve(result("timeout")) },
      failureFinalizer: {
        finalizeFailure: (input) => {
          finalized.push(input.outcome);
          return Promise.resolve();
        },
      },
      provisionalResultHandler: {
        handle: () => {
          provisionalCalled = true;
          return Promise.resolve();
        },
      },
    });

    const disposal = await handler.handle(prepared());

    assert.equal(disposal, "timeout");
    assert.deepEqual(finalized, ["timeout"]);
    assert.equal(provisionalCalled, false);
  });

  void it("keeps changes_ready provisional and does not perform successful Redmine finalization", async () => {
    let finalized = false;
    const provisional: string[] = [];
    const handler = new Phase48_5SandboxPreparedHandler({
      agentAdapter: { runAgent: () => Promise.resolve(result("changes_ready")) },
      failureFinalizer: {
        finalizeFailure: () => {
          finalized = true;
          return Promise.resolve();
        },
      },
      provisionalResultHandler: {
        handle: (input) => {
          provisional.push(input.result.outcome);
          return Promise.resolve();
        },
      },
    });

    const disposal = await handler.handle(prepared());

    assert.equal(disposal, "success");
    assert.equal(finalized, false);
    assert.deepEqual(provisional, ["changes_ready"]);
  });

  void it("keeps no_changes provisional and leaves durable success to Phase 49", async () => {
    let finalized = false;
    const provisional: string[] = [];
    const handler = new Phase48_5SandboxPreparedHandler({
      agentAdapter: { runAgent: () => Promise.resolve(result("no_changes")) },
      failureFinalizer: {
        finalizeFailure: () => {
          finalized = true;
          return Promise.resolve();
        },
      },
      provisionalResultHandler: {
        handle: (input) => {
          provisional.push(input.result.outcome);
          return Promise.resolve();
        },
      },
    });

    const disposal = await handler.handle(prepared());

    assert.equal(disposal, "success");
    assert.equal(finalized, false);
    assert.deepEqual(provisional, ["no_changes"]);
  });

  void it("maps adapter/redaction failure to agent_failed without persisting raw diagnostic", async () => {
    const finalized: string[] = [];
    const handler = new Phase48_5SandboxPreparedHandler({
      agentAdapter: { runAgent: () => Promise.reject(new Error("raw fixture-secret")) },
      failureFinalizer: {
        finalizeFailure: (input) => {
          finalized.push(input.outcome);
          return Promise.resolve();
        },
      },
      provisionalResultHandler: { handle: () => Promise.resolve() },
    });

    const disposal = await handler.handle(prepared());

    assert.equal(disposal, "failure");
    assert.deepEqual(finalized, ["agent_failed"]);
  });

  void it("does not claim success when failure finalization is rejected or unverifiable", async () => {
    const handler = new Phase48_5SandboxPreparedHandler({
      agentAdapter: { runAgent: () => Promise.resolve(result("agent_failed")) },
      failureFinalizer: {
        finalizeFailure: () => Promise.reject(new Error("finalization read-back mismatch")),
      },
      provisionalResultHandler: { handle: () => Promise.resolve() },
    });

    await assert.rejects(handler.handle(prepared()), /finalization read-back mismatch/u);
  });

  void it("maps checkout/sandbox preparation failure after Agent Running to agent_start_failed", async () => {
    const finalized: string[] = [];
    const handler = new Phase48_5SandboxPreparationFailureHandler({
      finalizeFailure: (input) => {
        finalized.push(input.outcome);
        return Promise.resolve();
      },
    });

    await handler.handle({ execution: execution(), error: new Error("checkout failed") });

    assert.deepEqual(finalized, ["agent_start_failed"]);
  });

  void it("exposes interrupted as the Phase 48-6 reconciliation fallback after unconfirmed finalization", () => {
    assert.equal(STARTED_FAILURE_RECONCILIATION_FALLBACK, "interrupted");
  });
});
