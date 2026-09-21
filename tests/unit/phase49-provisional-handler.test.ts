import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProvisionalAgentExecutionResult } from "../../src/agent/types.js";
import { Phase49ProvisionalResultHandler } from "../../src/artifact/phase49-provisional-handler.js";
import type { Phase49DevelopmentHandoffInput } from "../../src/artifact/contract.js";
import type { PreparedExecution } from "../../src/execution/types.js";
import type { RepositoryCheckoutResult } from "../../src/repository/types.js";
import type { TaskWorkspace } from "../../src/sandbox/types.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";

void describe("Phase 49-5 production provisional handler", () => {
  void it("collects changes before workspace disposal and forwards immutable identity to Phase 49 finalization", async () => {
    let captured: Phase49DevelopmentHandoffInput | undefined;
    const handler = new Phase49ProvisionalResultHandler({
      collector: {
        collect: (workspacePath) => {
          assert.equal(workspacePath, "/tmp/phase49-workspace");
          return Promise.resolve({
            changedFiles: [{ path: "a.txt", status: "modified" }],
            patch: { text: "patch", capturedBytes: 5, truncated: false },
          });
        },
      },
      finalization: {
        finalize: (handoff) => {
          captured = handoff;
          return Promise.resolve({
            kind: "artifact_failure",
            redmine: {
              executionId: EXECUTION_ID,
              issueId: 5422,
              lifecycle: "Needs Human",
              outcome: "artifact_persistence_failed",
              artifactReference: "",
              finishedAt: "2026-09-21T04:00:00.000Z",
            },
          });
        },
      },
    });

    await handler.handle({
      execution: execution(),
      result: result("changes_ready"),
      workspace: workspace(),
      checkout: checkout(),
    });

    if (captured === undefined) {
      throw new Error("Phase 49 handoff was not captured");
    }
    const actual = captured;
    assert.equal(actual.executionId, EXECUTION_ID);
    assert.equal(actual.issueId, 5422);
    assert.equal(actual.provisionalOutcome, "changes_ready");
    assert.deepEqual(actual.changedFiles, [{ path: "a.txt", status: "modified" }]);
  });

  void it("forwards canonical no_changes only when the collected changed-file set is empty", async () => {
    let finalizationCount = 0;
    const handler = new Phase49ProvisionalResultHandler({
      collector: {
        collect: () => Promise.resolve({
          changedFiles: [],
          patch: { text: "", capturedBytes: 0, truncated: false },
        }),
      },
      finalization: {
        finalize: (handoff) => {
          finalizationCount += 1;
          assert.equal(handoff.provisionalOutcome, "no_changes");
          return Promise.resolve({
            kind: "artifact_failure",
            redmine: {
              executionId: EXECUTION_ID,
              issueId: 5422,
              lifecycle: "Needs Human",
              outcome: "artifact_persistence_failed",
              artifactReference: "",
              finishedAt: "2026-09-21T04:00:00.000Z",
            },
          });
        },
      },
    });

    await handler.handle({
      execution: execution(),
      result: result("no_changes"),
      workspace: workspace(),
      checkout: checkout(),
    });

    assert.equal(finalizationCount, 1);
  });

  void it("forwards inconsistent provisional state to the canonical artifact validator instead of inventing another failure taxonomy", async () => {
    let captured: Phase49DevelopmentHandoffInput | undefined;
    const handler = new Phase49ProvisionalResultHandler({
      collector: {
        collect: () => Promise.resolve({
          changedFiles: [{ path: "unexpected.txt", status: "untracked" }],
          patch: { text: "patch", capturedBytes: 5, truncated: false },
        }),
      },
      finalization: {
        finalize: (handoff) => {
          captured = handoff;
          return Promise.resolve({
            kind: "artifact_failure",
            redmine: {
              executionId: EXECUTION_ID,
              issueId: 5422,
              lifecycle: "Needs Human",
              outcome: "artifact_persistence_failed",
              artifactReference: "",
              finishedAt: "2026-09-21T04:00:00.000Z",
            },
          });
        },
      },
    });

    await handler.handle({
      execution: execution(),
      result: result("no_changes"),
      workspace: workspace(),
      checkout: checkout(),
    });
    if (captured === undefined) {
      throw new Error("inconsistent handoff was not forwarded");
    }
    const actual = captured;
    assert.equal(actual.provisionalOutcome, "no_changes");
    assert.equal(actual.changedFiles.length, 1);
  });
});

function execution(): PreparedExecution {
  const repository = "mcp-mamono210/ai-agent-runner";
  const sourceRevision = "a".repeat(40);
  const briefRevision = 11;
  const persistedRevision = "persisted-revision-11";
  const requirementsFingerprint = `sha256:${"b".repeat(64)}`;
  const pending = Object.freeze({ kind: "pending" }) satisfies { readonly kind: "pending" };

  return {
    issue: {
      issueId: 5422,
      projectId: 414,
      lifecycle: "Agent Running",
      raw: {},
    },
    handoff: {
      issueId: 5422,
      repository,
      approvedRequirementsFingerprint: requirementsFingerprint,
      opaque: {},
    },
    input: {
      executionId: EXECUTION_ID,
      issueId: 5422,
      repository,
      sourceRevision,
      briefRevision,
      persistedRevision,
      requirementsFingerprint,
      approvedBriefReference: {
        repository,
        issueId: 5422,
        briefRevision,
        persistedRevision,
      },
    },
    record: {
      executionId: EXECUTION_ID,
      issueId: 5422,
      briefRevision,
      persistedRevision,
      requirementsFingerprint,
      repository,
      sourceRevision,
      startedAt: "2026-09-21T04:00:00.000Z",
      finishedAt: pending,
      outcome: pending,
      artifactReference: pending,
    },
  };
}

function workspace(): TaskWorkspace {
  return {
    executionId: EXECUTION_ID,
    path: "/tmp/phase49-workspace",
    diskLimitBytes: 1024,
    measureDiskUsageBytes: () => Promise.resolve(0),
    assertWithinDiskLimit: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
}

function checkout(): RepositoryCheckoutResult {
  return {
    repository: "mcp-mamono210/ai-agent-runner",
    sourceRevision: "a".repeat(40),
    headRevision: "a".repeat(40),
    targetDir: "/tmp/phase49-workspace",
  };
}

function result(outcome: "changes_ready" | "no_changes"): ProvisionalAgentExecutionResult {
  return {
    kind: "provisional_success",
    outcome,
    output: { text: "ok", capturedBytes: 2, truncated: false },
    diagnostic: { text: "", capturedBytes: 0, truncated: false },
  };
}
