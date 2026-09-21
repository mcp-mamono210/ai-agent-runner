import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPhase49Artifact } from "../../src/artifact/contract.js";
import { Phase49S3ArtifactPersistence } from "../../src/artifact/s3-persistence.js";
import {
  PHASE50_FAULT_DEFINITIONS,
  PHASE50_FAULT_IDS,
  PHASE50_SCENARIO_CONSUMERS,
  PHASE50_SCENARIO_IDS,
  Phase50DeterministicHarness,
  Phase50InjectedFaultError,
} from "../../src/verification/phase50-harness.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const BUCKET = "phase50-harness";
const PREFIX = "phase50/harness";

void describe("Phase 50-2 deterministic harness", () => {
  void it("declares every FI/SC control with at least one consumer", () => {
    assert.equal(PHASE50_FAULT_IDS.length, 15);
    assert.equal(PHASE50_SCENARIO_IDS.length, 7);

    for (const id of PHASE50_FAULT_IDS) {
      assert.ok(PHASE50_FAULT_DEFINITIONS[id].consumerTickets.length > 0, id);
    }
    for (const id of PHASE50_SCENARIO_IDS) {
      assert.ok(PHASE50_SCENARIO_CONSUMERS[id].length > 0, id);
    }
  });

  void it("distinguishes definite Agent Running failure from remote-success confirmation loss", async () => {
    const harness = new Phase50DeterministicHarness();

    harness.faults.arm("FI-01");
    await assert.rejects(harness.redmine.writeAgentRunning(), Phase50InjectedFaultError);
    assert.equal(harness.redmine.snapshot().lifecycle, "Ready for Agent");

    harness.reset();
    harness.faults.arm("FI-02");
    await assert.rejects(harness.redmine.writeAgentRunning(), Phase50InjectedFaultError);
    assert.equal(harness.redmine.snapshot().lifecycle, "Agent Running");
  });

  void it("provides deterministic authorization, output, disk, mutable-state, and corruption scenarios", async () => {
    const harness = new Phase50DeterministicHarness();

    harness.scenarios.set("SC-01", "deny");
    await assert.rejects(harness.formalAuthorizationGate(), /rejected: deny/u);

    harness.scenarios.set("SC-02", 8);
    assert.equal((await harness.agent.run("changes_ready")).output, "xxxxxxxx");

    harness.scenarios.set("SC-03", 1234);
    assert.equal(harness.sandbox.workspaceBytes(), 1234);

    harness.scenarios.set("SC-04", `sha256:${"c".repeat(64)}`);
    harness.scenarios.set("SC-05", 9);
    harness.scenarios.set("SC-06", "d".repeat(40));
    harness.applyMutableScenarios();
    assert.equal(harness.redmine.snapshot().requirementsFingerprint, `sha256:${"c".repeat(64)}`);
    assert.equal(harness.brief.currentRevision(), 9);
    assert.equal(harness.git.branchHead(), "d".repeat(40));

    harness.scenarios.set("SC-07", "checksum-mismatch");
    assert.equal(harness.scenarios.require("SC-07"), "checksum-mismatch");
  });

  for (const outcome of ["changes_ready", "no_changes"] as const) {
    void it(`runs the ${outcome} artifact baseline and keeps a durable object`, async () => {
      const harness = new Phase50DeterministicHarness();
      await harness.sandbox.applyNetworkPolicy();
      harness.sandbox.assertNetworkPolicyApplied();
      await harness.redmine.writeAgentRunning();
      await harness.agent.start();
      const result = await harness.agent.run(outcome);
      harness.checkpointAfterAgentResult();

      const artifact = artifactFixture(outcome);
      const persistence = new Phase49S3ArtifactPersistence({
        client: harness.s3,
        config: { region: "ap-northeast-1", bucket: BUCKET, prefix: PREFIX },
      });
      const persisted = await persistence.persistAndConfirm(artifact);
      harness.checkpointAfterArtifactPersistence();
      await harness.redmine.writeSuccessfulFinalization(result.outcome);

      assert.equal(harness.redmine.snapshot().lifecycle, "Ready for Independent Verification");
      assert.equal(harness.redmine.snapshot().outcome, outcome);
      assert.equal(harness.s3.hasObject(BUCKET, `${PREFIX}/${EXECUTION_ID}.json`), true);
      assert.match(persisted.artifactReference, /^s3:\/\//u);
    });
  }

  void it("proves the artifact negative control fails for a wrong checksum", async () => {
    const harness = new Phase50DeterministicHarness();
    const artifact = artifactFixture("changes_ready");
    const persistence = new Phase49S3ArtifactPersistence({
      client: harness.s3,
      config: { region: "ap-northeast-1", bucket: BUCKET, prefix: PREFIX },
    });
    const persisted = await persistence.persistAndConfirm(artifact);

    harness.scenarios.set("SC-07", "checksum-mismatch");
    await assert.rejects(
      persistence.getAndVerify(persisted.artifactReference, artifact),
      /checksum/u,
    );
  });

  void it("provides one-shot before/after/checkpoint fault semantics", async () => {
    const harness = new Phase50DeterministicHarness();

    harness.faults.arm("FI-03");
    await assert.rejects(harness.agent.start(), Phase50InjectedFaultError);
    await assert.doesNotReject(harness.agent.start());

    harness.faults.arm("FI-06");
    assert.throws(() => harness.checkpointAfterAgentResult(), Phase50InjectedFaultError);
    assert.doesNotThrow(() => harness.checkpointAfterAgentResult());

    harness.faults.arm("FI-15");
    await assert.rejects(harness.sandbox.applyNetworkPolicy(), Phase50InjectedFaultError);
    assert.throws(() => harness.sandbox.assertNetworkPolicyApplied(), /was not applied/u);
  });


  void it("exposes every remaining FI seam through the shared harness ports", async () => {
    const harness = new Phase50DeterministicHarness();

    harness.faults.arm("FI-04");
    await assert.rejects(harness.agent.run("changes_ready"), Phase50InjectedFaultError);

    harness.faults.arm("FI-05");
    await assert.rejects(harness.agent.run("changes_ready"), Phase50InjectedFaultError);

    const artifact = artifactFixture("changes_ready");
    const put = {
      bucket: BUCKET,
      key: `${PREFIX}/${EXECUTION_ID}.json`,
      body: artifact.body,
      metadata: artifact.metadata,
      checksumAlgorithm: artifact.checksumAlgorithm,
      checksumSha256Base64: artifact.envelopeChecksumSha256Base64,
      ifNoneMatch: "*" as const,
      serverSideEncryption: "AES256" as const,
    };

    harness.faults.arm("FI-07");
    await assert.rejects(harness.s3.putObject(put), Phase50InjectedFaultError);
    assert.equal(harness.s3.hasObject(BUCKET, put.key), false);

    harness.faults.arm("FI-08");
    await assert.rejects(harness.s3.putObject(put), Phase50InjectedFaultError);
    assert.equal(harness.s3.hasObject(BUCKET, put.key), true);

    harness.faults.arm("FI-09");
    assert.throws(() => harness.checkpointAfterArtifactPersistence(), Phase50InjectedFaultError);

    await harness.redmine.writeAgentRunning();
    harness.faults.arm("FI-11", { timing: "before" });
    await assert.rejects(harness.redmine.writeFailureFinalization("agent_failed"), Phase50InjectedFaultError);
    assert.equal(harness.redmine.snapshot().lifecycle, "Agent Running");

    harness.faults.arm("FI-11", { timing: "after" });
    await assert.rejects(harness.redmine.writeFailureFinalization("agent_failed"), Phase50InjectedFaultError);
    assert.equal(harness.redmine.snapshot().lifecycle, "Needs Human");

    harness.faults.arm("FI-12");
    await assert.rejects(
      harness.s3.headObject({ bucket: BUCKET, key: put.key, checksumMode: "ENABLED" }),
      Phase50InjectedFaultError,
    );

    harness.faults.arm("FI-13");
    await assert.rejects(
      harness.s3.getObject({ bucket: BUCKET, key: put.key, checksumMode: "ENABLED" }),
      Phase50InjectedFaultError,
    );

    harness.reset();
    harness.faults.arm("FI-14");
    await assert.rejects(harness.formalAuthorizationGate(), Phase50InjectedFaultError);
  });
  void it("can model both definite and remote-success finalization failures", async () => {
    const definite = new Phase50DeterministicHarness();
    await definite.redmine.writeAgentRunning();
    definite.faults.arm("FI-10", { timing: "before" });
    await assert.rejects(
      definite.redmine.writeSuccessfulFinalization("changes_ready"),
      Phase50InjectedFaultError,
    );
    assert.equal(definite.redmine.snapshot().lifecycle, "Agent Running");

    const ambiguous = new Phase50DeterministicHarness();
    await ambiguous.redmine.writeAgentRunning();
    ambiguous.faults.arm("FI-10", { timing: "after" });
    await assert.rejects(
      ambiguous.redmine.writeSuccessfulFinalization("changes_ready"),
      Phase50InjectedFaultError,
    );
    assert.equal(ambiguous.redmine.snapshot().lifecycle, "Ready for Independent Verification");
  });
});

function artifactFixture(outcome: "changes_ready" | "no_changes") {
  const patch = outcome === "changes_ready"
    ? "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"
    : "";
  return buildPhase49Artifact({
    executionId: EXECUTION_ID,
    issueId: 5426,
    repository: "mcp-mamono210/ai-agent-runner",
    sourceRevision: "a".repeat(40),
    briefRevision: 1,
    persistedRevision: "phase50-harness",
    requirementsFingerprint: `sha256:${"b".repeat(64)}`,
    outcome,
    changedFiles: outcome === "changes_ready" ? [{ path: "a.txt", status: "modified" }] : [],
    patch: {
      text: patch,
      capturedBytes: Buffer.byteLength(patch, "utf8"),
      truncated: false,
    },
  });
}
