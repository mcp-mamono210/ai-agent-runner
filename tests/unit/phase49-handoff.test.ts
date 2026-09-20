import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProvisionalAgentExecutionResult } from "../../src/agent/types.js";
import {
  InMemoryDevelopmentPhase49HandoffStore,
  Phase48_7ProvisionalResultHandler,
} from "../../src/development/phase49-handoff.js";
import type { PreparedExecution } from "../../src/execution/types.js";
import type { RepositoryCheckoutResult } from "../../src/repository/types.js";
import type { TaskWorkspace } from "../../src/sandbox/types.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SOURCE_REVISION = "a".repeat(40);
const FINGERPRINT = `sha256:${"b".repeat(64)}`;

void describe("Phase 48-7 Phase 49 development handoff", () => {
  void it("preserves immutable execution identity and captures the provisional change-set boundary", async () => {
    const store = new InMemoryDevelopmentPhase49HandoffStore();
    const handler = new Phase48_7ProvisionalResultHandler({
      collector: {
        collect: () => Promise.resolve({
          changedFiles: [{ path: "src/example.ts", status: "modified" }],
          patch: { text: "diff --git a/src/example.ts b/src/example.ts\n", capturedBytes: 48, truncated: false },
        }),
      },
      sink: store,
      summaryCaptureBytes: 4096,
    });

    await handler.handle({
      execution: execution(),
      result: result("changes_ready"),
      workspace: workspace(),
      checkout: checkout(),
    });

    const handoffs = store.list();
    assert.equal(handoffs.length, 1);
    const handoff = handoffs[0]!;
    assert.equal(handoff.executionId, EXECUTION_ID);
    assert.equal(handoff.issueId, 5416);
    assert.equal(handoff.repository, "mcp-mamono210/example");
    assert.equal(handoff.sourceRevision, SOURCE_REVISION);
    assert.equal(handoff.briefRevision, 7);
    assert.equal(handoff.persistedRevision, "persisted-revision");
    assert.equal(handoff.requirementsFingerprint, FINGERPRINT);
    assert.equal(handoff.provisionalOutcome, "changes_ready");
    assert.deepEqual(handoff.changedFiles, [{ path: "src/example.ts", status: "modified" }]);
    assert.match(handoff.executionSummary.text, /outcome=changes_ready/u);
    assert.equal(handoff.executionSummary.truncated, false);
  });

  void it("fails safe when provisional outcome and local change-set disagree", async () => {
    const handler = new Phase48_7ProvisionalResultHandler({
      collector: {
        collect: () => Promise.resolve({
          changedFiles: [{ path: "unexpected.txt", status: "untracked" }],
          patch: { text: "patch", capturedBytes: 5, truncated: false },
        }),
      },
      sink: new InMemoryDevelopmentPhase49HandoffStore(),
      summaryCaptureBytes: 4096,
    });

    await assert.rejects(
      handler.handle({
        execution: execution(),
        result: result("no_changes"),
        workspace: workspace(),
        checkout: checkout(),
      }),
      /no_changes result produced changed files/u,
    );
  });
});

function execution(): PreparedExecution {
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

function workspace(): TaskWorkspace {
  return {
    executionId: EXECUTION_ID,
    path: "/tmp/phase48-7-workspace",
    diskLimitBytes: 1024,
    measureDiskUsageBytes: () => Promise.resolve(0),
    assertWithinDiskLimit: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
}

function checkout(): RepositoryCheckoutResult {
  return {
    repository: "mcp-mamono210/example",
    sourceRevision: SOURCE_REVISION,
    targetDir: "/tmp/phase48-7-workspace",
    headRevision: SOURCE_REVISION,
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
