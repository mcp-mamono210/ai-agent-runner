import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPhase49Artifact } from "../../src/artifact/contract.js";
import {
  PHASE49_DEFAULT_S3_PREFIX,
  Phase49S3OperationError,
  type Phase49RecoveredArtifact,
} from "../../src/artifact/s3-persistence.js";
import type { RedmineIssueRecord } from "../../src/redmine/domain.js";
import { Phase49ArtifactAwareExecutionReconciler } from "../../src/recovery/phase49-artifact-reconciler.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";

void describe("Phase 49-5 artifact-aware startup reconciliation", () => {
  void it("finalizes a valid recovered artifact as successful without invoking interrupted fallback", async () => {
    const issue = activeIssue();
    let successCount = 0;
    let interruptedCount = 0;
    const reconciler = new Phase49ArtifactAwareExecutionReconciler({
      reader: { getIssue: () => Promise.resolve(issue) },
      allowedProjectIds: [414],
      recovery: { recoverAndVerify: () => Promise.resolve(recoveredArtifact()) },
      successFinalizer: {
        finalizeSuccess: ({ artifact, persisted }) => {
          successCount += 1;
          assert.equal(artifact.manifest.executionId, EXECUTION_ID);
          assert.match(persisted.artifactReference, /^s3:\/\//u);
          return Promise.resolve({
            executionId: EXECUTION_ID,
            issueId: 5422,
            lifecycle: "Ready for Independent Verification",
            outcome: "changes_ready",
            artifactReference: persisted.artifactReference,
            finishedAt: "2026-09-21T04:00:00.000Z",
          });
        },
      },
      absentArtifactFinalizer: {
        finalizeInterrupted: () => {
          interruptedCount += 1;
          return Promise.resolve();
        },
      },
    });

    await reconciler.finalizeInterrupted(5422);

    assert.equal(successCount, 1);
    assert.equal(interruptedCount, 0);
  });

  void it("uses interrupted / Needs Human only for explicit artifact not_found", async () => {
    let interruptedCount = 0;
    const reconciler = new Phase49ArtifactAwareExecutionReconciler({
      reader: { getIssue: () => Promise.resolve(activeIssue()) },
      allowedProjectIds: [414],
      recovery: {
        recoverAndVerify: () => Promise.reject(new Phase49S3OperationError("not_found", "missing")),
      },
      successFinalizer: { finalizeSuccess: () => Promise.reject(new Error("unexpected success")) },
      absentArtifactFinalizer: {
        finalizeInterrupted: () => {
          interruptedCount += 1;
          return Promise.resolve();
        },
      },
    });

    await reconciler.finalizeInterrupted(5422);

    assert.equal(interruptedCount, 1);
  });

  void it("does not reinterpret access denied or invalid artifact as absence", async () => {
    let interruptedCount = 0;
    let successCount = 0;
    const reconciler = new Phase49ArtifactAwareExecutionReconciler({
      reader: { getIssue: () => Promise.resolve(activeIssue()) },
      allowedProjectIds: [414],
      recovery: {
        recoverAndVerify: () => Promise.reject(new Phase49S3OperationError("access_denied", "403")),
      },
      successFinalizer: {
        finalizeSuccess: () => {
          successCount += 1;
          return Promise.reject(new Error("unexpected success"));
        },
      },
      absentArtifactFinalizer: {
        finalizeInterrupted: () => {
          interruptedCount += 1;
          return Promise.resolve();
        },
      },
    });

    await assert.rejects(reconciler.finalizeInterrupted(5422), /403/u);
    assert.equal(successCount, 0);
    assert.equal(interruptedCount, 0);
  });

  void it("rejects stale Agent Running identity before S3 recovery", async () => {
    const issue = activeIssue();
    const executionField = issue.customFields.find((field) => field.name === "Agent Execution ID");
    assert.ok(executionField !== undefined);
    const stale: RedmineIssueRecord = {
      ...issue,
      customFields: issue.customFields.map((field) =>
        field.name === "Agent Execution ID" ? { ...field, value: "stale" } : field,
      ),
    };
    let recoveryCount = 0;
    const reconciler = new Phase49ArtifactAwareExecutionReconciler({
      reader: { getIssue: () => Promise.resolve(stale) },
      allowedProjectIds: [414],
      recovery: {
        recoverAndVerify: () => {
          recoveryCount += 1;
          return Promise.resolve(recoveredArtifact());
        },
      },
      successFinalizer: { finalizeSuccess: () => Promise.reject(new Error("unexpected")) },
      absentArtifactFinalizer: { finalizeInterrupted: () => Promise.resolve() },
    });

    await assert.rejects(reconciler.finalizeInterrupted(5422), /execution_id/u);
    assert.equal(recoveryCount, 0);
  });
});

function activeIssue(): RedmineIssueRecord {
  const values = new Map<string, string>([
    ["Agent Execution Lifecycle", "Agent Running"],
    ["Agent Execution ID", EXECUTION_ID],
    ["Agent Exec Brief Revision", "11"],
    ["Agent Exec Persisted Revision", "persisted-revision-11"],
    ["Agent Exec Req Fingerprint", `sha256:${"b".repeat(64)}`],
    ["Agent Execution Repository", "mcp-mamono210/ai-agent-runner"],
    ["Agent Exec Source Revision", "a".repeat(40)],
    ["Agent Execution Started At", "2026-09-21T03:00:00.000Z"],
    ["Agent Execution Finished At", ""],
    ["Agent Execution Outcome", ""],
    ["Agent Artifact Reference", ""],
  ]);
  return {
    id: 5422,
    project: { id: 414, name: "Redmine" },
    tracker: { id: 2, name: "Feature" },
    subject: "Phase 49-5",
    description: "",
    customFields: [...values.entries()].map(([name, value], index) => ({
      id: 11 + index,
      name,
      value,
    })),
    updatedOn: "2026-09-21T03:00:00Z",
    journals: [],
    relations: [],
    children: [],
  };
}

function recoveredArtifact(): Phase49RecoveredArtifact {
  const artifact = buildPhase49Artifact({
    executionId: EXECUTION_ID,
    issueId: 5422,
    repository: "mcp-mamono210/ai-agent-runner",
    sourceRevision: "a".repeat(40),
    briefRevision: 11,
    persistedRevision: "persisted-revision-11",
    requirementsFingerprint: `sha256:${"b".repeat(64)}`,
    outcome: "changes_ready",
    changedFiles: [{ path: "a.txt", status: "modified" }],
    patch: { text: "patch", capturedBytes: 5, truncated: false },
  });
  const key = `${PHASE49_DEFAULT_S3_PREFIX}/${EXECUTION_ID}.json`;
  return {
    artifact,
    persisted: {
      bucket: "phase49-artifacts-example",
      key,
      artifactReference: `s3://phase49-artifacts-example/${key}`,
      adoptedExistingObject: true,
    },
    document: { manifest: artifact.manifest, patch: "patch" },
  };
}

