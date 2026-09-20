import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Phase48_6StartupReconciler } from "../../src/recovery/startup-reconciler.js";
import { KnownSecretRedactor } from "../../src/security/redaction.js";

void describe("Phase 48-6 startup reconciliation", () => {
  void it("cleans transient resources before reconciling Agent Running and never invokes an Agent", async () => {
    const order: string[] = [];
    const diagnostics: string[] = [];
    const reconciler = new Phase48_6StartupReconciler({
      cleaner: {
        cleanup: () => {
          order.push("cleanup");
          return Promise.resolve({ removedSandboxContainers: 1, removedWorkspaces: 1 });
        },
      },
      source: {
        listAgentRunningExecutions: () => {
          order.push("list");
          return Promise.resolve([{ issueId: 5415, projectId: 414 }]);
        },
      },
      finalizer: {
        finalizeInterrupted: (issueId) => {
          order.push(`finalize:${issueId}`);
          return Promise.resolve();
        },
      },
      redactor: new KnownSecretRedactor([]),
      diagnosticSink: {
        record: (input) => {
          diagnostics.push(input.message);
          return Promise.resolve();
        },
      },
    });

    await reconciler.reconcile();

    assert.deepEqual(order, ["cleanup", "list", "finalize:5415"]);
    assert.equal(diagnostics.some((entry) => entry.includes("removed transient orphan resources")), true);
    assert.equal(diagnostics.some((entry) => entry.includes("finalized as interrupted")), true);
  });

  void it("keeps reconciliation unconfirmed and redacts secret-bearing failure diagnostics", async () => {
    const diagnostics: string[] = [];
    const reconciler = new Phase48_6StartupReconciler({
      cleaner: { cleanup: () => Promise.resolve({ removedSandboxContainers: 0, removedWorkspaces: 0 }) },
      source: {
        listAgentRunningExecutions: () => Promise.resolve([{ issueId: 5415, projectId: 414 }]),
      },
      finalizer: {
        finalizeInterrupted: () => Promise.reject(new Error("write failed token=fixture-secret")),
      },
      redactor: new KnownSecretRedactor(["fixture-secret"]),
      diagnosticSink: {
        record: (input) => {
          diagnostics.push(input.message);
          return Promise.resolve();
        },
      },
    });

    await assert.rejects(reconciler.reconcile(), /did not confirm every Agent Running execution/u);
    assert.equal(diagnostics.some((entry) => entry.includes("fixture-secret")), false);
    assert.equal(diagnostics.some((entry) => entry.includes("[REDACTED]")), true);
  });

  void it("suppresses raw content if redaction itself fails", async () => {
    const diagnostics: string[] = [];
    const reconciler = new Phase48_6StartupReconciler({
      cleaner: { cleanup: () => Promise.reject(new Error("raw-secret")) },
      source: { listAgentRunningExecutions: () => Promise.resolve([]) },
      finalizer: { finalizeInterrupted: () => Promise.resolve() },
      redactor: { redact: () => { throw new Error("scanner failed"); } },
      diagnosticSink: {
        record: (input) => {
          diagnostics.push(input.message);
          return Promise.resolve();
        },
      },
    });

    await assert.rejects(reconciler.reconcile(), /raw content suppressed/u);
    assert.deepEqual(diagnostics, ["recovery diagnostic redaction failed; raw content suppressed"]);
  });
  void it("allows a later startup pass to retry state reconciliation without retrying Agent execution", async () => {
    let attempts = 0;
    const reconciler = new Phase48_6StartupReconciler({
      cleaner: { cleanup: () => Promise.resolve({ removedSandboxContainers: 0, removedWorkspaces: 0 }) },
      source: {
        listAgentRunningExecutions: () => Promise.resolve([{ issueId: 5415, projectId: 414 }]),
      },
      finalizer: {
        finalizeInterrupted: () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error("unconfirmed write"))
            : Promise.resolve();
        },
      },
      redactor: new KnownSecretRedactor([]),
    });

    await assert.rejects(reconciler.reconcile(), /did not confirm every Agent Running execution/u);
    await reconciler.reconcile();

    assert.equal(attempts, 2);
  });

});
