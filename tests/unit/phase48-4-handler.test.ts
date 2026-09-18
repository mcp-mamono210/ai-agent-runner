import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import type { PreparedExecution } from "../../src/execution/types.js";
import type { RepositoryCheckout } from "../../src/repository/types.js";
import { Phase48_4AgentRunningConfirmedHandler } from "../../src/sandbox/phase48-4-handler.js";
import type {
  SandboxDisposalReason,
  SandboxPreparationFailureHandler,
  SandboxPreparedHandler,
  SandboxRuntime,
} from "../../src/sandbox/types.js";
import { TaskWorkspaceManager } from "../../src/sandbox/workspace.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SOURCE_REVISION = "a".repeat(40);

function execution(): PreparedExecution {
  const pending = Object.freeze({ kind: "pending" }) satisfies { readonly kind: "pending" };
  const reference = Object.freeze({
    repository: "mcp-mamono210/redmine",
    issueId: 5413,
    briefRevision: 2,
    persistedRevision: "persisted",
  });
  const input = Object.freeze({
    executionId: EXECUTION_ID,
    issueId: 5413,
    repository: reference.repository,
    sourceRevision: SOURCE_REVISION,
    briefRevision: reference.briefRevision,
    persistedRevision: reference.persistedRevision,
    requirementsFingerprint: `sha256:${"b".repeat(64)}`,
    approvedBriefReference: reference,
  });
  return Object.freeze({
    issue: { issueId: 5413, projectId: 414, lifecycle: "Ready for Agent", raw: {} },
    handoff: {
      issueId: 5413,
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

void describe("Phase 48-4 post-Agent-Running workspace/sandbox handler", () => {
  void it("provides checkout target_dir, then sandbox, and disposes using downstream terminal class", async () => {
    const base = await mkdtemp(join(tmpdir(), "phase48-4-handler-"));
    try {
      const workspaceManager = new TaskWorkspaceManager({ root: base, diskLimitBytes: 1024 });
      let checkoutTarget = "";
      const repository: RepositoryCheckout = {
        checkout: (input) => {
          checkoutTarget = input.targetDir;
          return Promise.resolve({
            repository: input.repository,
            sourceRevision: input.sourceRevision,
            targetDir: input.targetDir,
            headRevision: input.sourceRevision,
          });
        },
      };
      const disposalReasons: SandboxDisposalReason[] = [];
      const sandboxRuntime: SandboxRuntime = {
        create: ({ workspace }) => Promise.resolve({
          containerId: "c".repeat(64),
          executionId: EXECUTION_ID,
          workspace,
          resources: {
            executionTimeoutMs: 1,
            outputCaptureBytes: 1,
            diagnosticCaptureBytes: 1,
            workspaceDiskBytes: 1024,
            containerLifecycleMs: 2,
            workspaceCheckIntervalMs: 1,
            tmpfsBytes: 1,
          },
          enforcementSignal: new AbortController().signal,
          inspectIsolation: () => Promise.resolve({
            containerId: "c".repeat(64),
            workspaceSource: workspace.path,
            workspaceDestination: "/workspace",
            networkName: "network",
            policyDigest: `sha256:${"d".repeat(64)}`,
          }),
          dispose: (reason) => {
            disposalReasons.push(reason);
            return workspace.dispose();
          },
        }),
      };
      const next: SandboxPreparedHandler = {
        handle: (input) => {
          assert.equal(input.workspace.path, checkoutTarget);
          assert.equal(input.checkout.headRevision, SOURCE_REVISION);
          return Promise.resolve("timeout");
        },
      };
      const failureHandler: SandboxPreparationFailureHandler = {
        handle: () => Promise.reject(new Error("unexpected preparation failure")),
      };
      const handler = new Phase48_4AgentRunningConfirmedHandler({
        workspaceManager,
        repository,
        sandboxRuntime,
        next,
        preAgentFailureHandler: failureHandler,
      });

      await handler.handle(execution());

      assert.equal(dirname(checkoutTarget), await realpath(base));
      assert.deepEqual(disposalReasons, ["timeout"]);
      assert.deepEqual(await readdir(base), []);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  void it("routes post-Agent-Running preparation failure to Phase 48-5 hook and still cleans workspace", async () => {
    const base = await mkdtemp(join(tmpdir(), "phase48-4-handler-failure-"));
    try {
      const failures: unknown[] = [];
      const repository: RepositoryCheckout = {
        checkout: () => Promise.reject(new Error("checkout failed")),
      };
      const failureHandler: SandboxPreparationFailureHandler = {
        handle: (input) => {
          failures.push(input.error);
          return Promise.resolve();
        },
      };
      const handler = new Phase48_4AgentRunningConfirmedHandler({
        workspaceManager: new TaskWorkspaceManager({ root: base, diskLimitBytes: 1024 }),
        repository,
        sandboxRuntime: {
          create: () => Promise.reject(new Error("sandbox should not be created")),
        },
        next: {
          handle: () => Promise.reject(new Error("next should not be called")),
        },
        preAgentFailureHandler: failureHandler,
      });

      await assert.rejects(handler.handle(execution()), /checkout failed/u);

      assert.equal(failures.length, 1);
      assert.deepEqual(await readdir(base), []);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
