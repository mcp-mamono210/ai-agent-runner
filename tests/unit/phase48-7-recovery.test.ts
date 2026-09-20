import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Phase48_5SandboxPreparedHandler } from "../../src/agent/phase48-5-handler.js";
import type { PreparedExecution } from "../../src/execution/types.js";
import { Phase48_6StartupReconciler } from "../../src/recovery/startup-reconciler.js";
import type { PreparedSandboxExecution } from "../../src/sandbox/types.js";
import { KnownSecretRedactor } from "../../src/security/redaction.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SOURCE_REVISION = "a".repeat(40);
const FINGERPRINT = `sha256:${"b".repeat(64)}`;

void describe("Phase 48-7 failure-finalization recovery verification", () => {
  void it("leaves an unconfirmed started failure for restart reconciliation and never retries the Agent", async () => {
    let agentInvocations = 0;
    let startedFailureWrites = 0;
    let interruptedWrites = 0;
    const diagnostics: string[] = [];

    const phase48_5 = new Phase48_5SandboxPreparedHandler({
      agentAdapter: {
        runAgent: () => {
          agentInvocations += 1;
          return Promise.resolve({
            kind: "started_failure",
            outcome: "timeout",
            output: { text: "", capturedBytes: 0, truncated: false },
            diagnostic: { text: "token=fixture-secret", capturedBytes: 20, truncated: false },
          });
        },
      },
      failureFinalizer: {
        finalizeFailure: () => {
          startedFailureWrites += 1;
          return Promise.reject(new Error("Redmine write could not be confirmed token=fixture-secret"));
        },
      },
      provisionalResultHandler: { handle: () => Promise.resolve() },
    });

    await assert.rejects(phase48_5.handle(preparedSandbox()), /could not be confirmed/u);
    assert.equal(agentInvocations, 1);
    assert.equal(startedFailureWrites, 1);

    const startupReconciler = new Phase48_6StartupReconciler({
      cleaner: {
        cleanup: () => Promise.resolve({ removedSandboxContainers: 1, removedWorkspaces: 1 }),
      },
      source: {
        listAgentRunningExecutions: () => Promise.resolve([{ issueId: 5416, projectId: 414 }]),
      },
      finalizer: {
        finalizeInterrupted: () => {
          interruptedWrites += 1;
          return Promise.resolve();
        },
      },
      redactor: new KnownSecretRedactor(["fixture-secret"]),
      diagnosticSink: {
        record: (input) => {
          diagnostics.push(input.message);
          return Promise.resolve();
        },
      },
    });

    await startupReconciler.reconcile();

    assert.equal(agentInvocations, 1);
    assert.equal(startedFailureWrites, 1);
    assert.equal(interruptedWrites, 1);
    assert.equal(diagnostics.some((entry) => entry.includes("fixture-secret")), false);
    assert.equal(diagnostics.some((entry) => entry.includes("finalized as interrupted")), true);
  });
});

function preparedSandbox(): PreparedSandboxExecution {
  const execution = preparedExecution();
  const workspace = {
    executionId: EXECUTION_ID,
    path: "/tmp/phase48-7-recovery",
    diskLimitBytes: 1024,
    measureDiskUsageBytes: () => Promise.resolve(0),
    assertWithinDiskLimit: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
  return {
    execution,
    workspace,
    checkout: {
      repository: execution.input.repository,
      sourceRevision: SOURCE_REVISION,
      targetDir: workspace.path,
      headRevision: SOURCE_REVISION,
    },
    sandbox: {
      containerId: "sandbox",
      executionId: EXECUTION_ID,
      workspace,
      resources: {
        executionTimeoutMs: 1000,
        outputCaptureBytes: 1024,
        diagnosticCaptureBytes: 1024,
        workspaceDiskBytes: 1024,
        containerLifecycleMs: 2000,
        workspaceCheckIntervalMs: 100,
        tmpfsBytes: 1024,
      },
      enforcementSignal: new AbortController().signal,
      inspectIsolation: () => Promise.reject(new Error("not used")),
      dispose: () => Promise.resolve(),
    },
  };
}

function preparedExecution(): PreparedExecution {
  return {
    issue: { issueId: 5416, projectId: 414, lifecycle: "Ready for Agent", raw: {} },
    handoff: {
      issueId: 5416,
      repository: "mcp-mamono210/example",
      approvedRequirementsFingerprint: FINGERPRINT,
      approval: {
        approverIdentity: "redmine-user:3",
        approvedAt: "2026-09-21T00:00:00Z",
        briefRevision: 7,
        persistedRevision: "persisted-revision",
      },
      opaque: {},
    },
    input: {
      executionId: EXECUTION_ID,
      issueId: 5416,
      repository: "mcp-mamono210/example",
      sourceRevision: SOURCE_REVISION,
      briefRevision: 7,
      persistedRevision: "persisted-revision",
      requirementsFingerprint: FINGERPRINT,
      approvedBriefReference: {
        repository: "mcp-mamono210/example",
        issueId: 5416,
        briefRevision: 7,
        persistedRevision: "persisted-revision",
      },
    },
    record: {
      executionId: EXECUTION_ID,
      issueId: 5416,
      briefRevision: 7,
      persistedRevision: "persisted-revision",
      requirementsFingerprint: FINGERPRINT,
      repository: "mcp-mamono210/example",
      sourceRevision: SOURCE_REVISION,
      startedAt: "2026-09-21T00:00:01.000Z",
      finishedAt: { kind: "pending" },
      outcome: { kind: "pending" },
      artifactReference: { kind: "pending" },
    },
  };
}
