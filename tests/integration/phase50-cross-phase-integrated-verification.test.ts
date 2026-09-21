import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildPhase49Artifact } from "../../src/artifact/contract.js";
import { Phase49S3ArtifactPersistence } from "../../src/artifact/s3-persistence.js";
import { InMemoryIssueLock } from "../../src/controller/local-lock.js";
import {
  PHASE50_SCENARIO_IDS,
  Phase50DeterministicHarness,
  Phase50InjectedFaultError,
} from "../../src/verification/phase50-harness.js";

const ISSUE_ID = 5432;
const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const BUCKET = "phase50-cross-phase";
const PREFIX = "phase50/cross-phase";
const OBJECT_KEY = `${PREFIX}/${EXECUTION_ID}.json`;
const BASELINE_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const MUTATED_FINGERPRINT = `sha256:${"c".repeat(64)}`;

const CANONICAL_ORDER = [
  "authorization-snapshot",
  "successful-artifact",
  "fault-rejection",
  "resource-boundary",
] as const;

type CrossPhaseScenario = (typeof CANONICAL_ORDER)[number];

interface ScenarioObservation {
  readonly scenario: CrossPhaseScenario;
  readonly evidence: readonly string[];
}

void describe("Phase 50-8 cross-phase integrated verification", () => {
  void it("is order-independent, repeatable in one harness process, and residue-free", async () => {
    const fixture = await CrossPhaseFixture.create();
    try {
      const canonical = await runScenarioOrder(fixture, CANONICAL_ORDER);
      const alternate = await runScenarioOrder(fixture, [...CANONICAL_ORDER].reverse());
      const repeat = await runScenarioOrder(fixture, CANONICAL_ORDER);

      assert.deepEqual(normalize(alternate), normalize(canonical));
      assert.deepEqual(normalize(repeat), normalize(canonical));
      await fixture.assertClean();
    } finally {
      await fixture.dispose();
    }
  });
});

class CrossPhaseFixture {
  readonly harness = new Phase50DeterministicHarness();
  readonly lock = new InMemoryIssueLock();
  readonly root: string;
  readonly workspace: string;

  private constructor(root: string) {
    this.root = root;
    this.workspace = join(root, "workspace");
  }

  static async create(): Promise<CrossPhaseFixture> {
    const root = await mkdtemp(join(tmpdir(), "phase50-8-cross-phase-"));
    const fixture = new CrossPhaseFixture(root);
    await mkdir(fixture.workspace, { recursive: true });
    await fixture.assertClean();
    return fixture;
  }

  async reset(): Promise<void> {
    this.harness.reset();
    if (this.lock.isHeld(ISSUE_ID)) {
      this.lock.release(ISSUE_ID);
    }
    await rm(this.workspace, { recursive: true, force: true });
    await mkdir(this.workspace, { recursive: true });
  }

  async assertClean(): Promise<void> {
    assert.deepEqual(this.harness.redmine.snapshot(), {
      lifecycle: "Ready for Agent",
      outcome: "",
      requirementsFingerprint: BASELINE_FINGERPRINT,
    });
    assert.equal(this.harness.brief.currentRevision(), 1);
    assert.equal(this.harness.git.branchHead(), "b".repeat(40));
    assert.equal(this.harness.s3.hasObject(BUCKET, OBJECT_KEY), false);
    assert.equal(this.lock.isHeld(ISSUE_ID), false);
    assert.deepEqual(this.harness.faults.observed(), []);
    for (const id of PHASE50_SCENARIO_IDS) {
      assert.equal(this.harness.scenarios.get(id), undefined, id);
    }
    assert.throws(
      () => this.harness.sandbox.assertNetworkPolicyApplied(),
      /was not applied/u,
    );
    assert.deepEqual(await readdir(this.workspace), []);
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

async function runScenarioOrder(
  fixture: CrossPhaseFixture,
  order: readonly CrossPhaseScenario[],
): Promise<readonly ScenarioObservation[]> {
  const observations: ScenarioObservation[] = [];
  for (const scenario of order) {
    await fixture.assertClean();
    observations.push(await runScenario(fixture, scenario));
    await fixture.reset();
    await fixture.assertClean();
  }
  return observations;
}

async function runScenario(
  fixture: CrossPhaseFixture,
  scenario: CrossPhaseScenario,
): Promise<ScenarioObservation> {
  switch (scenario) {
    case "authorization-snapshot":
      return await runAuthorizationSnapshot(fixture);
    case "successful-artifact":
      return await runSuccessfulArtifact(fixture);
    case "fault-rejection":
      return await runFaultRejection(fixture);
    case "resource-boundary":
      return await runResourceBoundary(fixture);
  }
}

async function runAuthorizationSnapshot(
  fixture: CrossPhaseFixture,
): Promise<ScenarioObservation> {
  fixture.harness.scenarios.set("SC-01", "allow");
  fixture.harness.scenarios.set("SC-04", MUTATED_FINGERPRINT);
  fixture.harness.scenarios.set("SC-05", 9);
  fixture.harness.scenarios.set("SC-06", "d".repeat(40));
  fixture.harness.applyMutableScenarios();
  await fixture.harness.formalAuthorizationGate();
  await writeFile(join(fixture.workspace, "snapshot-observed.txt"), "observed\n", "utf8");

  return Object.freeze({
    scenario: "authorization-snapshot",
    evidence: Object.freeze([
      fixture.harness.redmine.snapshot().requirementsFingerprint,
      String(fixture.harness.brief.currentRevision()),
      fixture.harness.git.branchHead(),
    ]),
  });
}

async function runSuccessfulArtifact(
  fixture: CrossPhaseFixture,
): Promise<ScenarioObservation> {
  assert.equal(fixture.lock.tryAcquire(ISSUE_ID), true);
  assert.equal(fixture.lock.tryAcquire(ISSUE_ID), false);
  await fixture.harness.sandbox.applyNetworkPolicy();
  fixture.harness.sandbox.assertNetworkPolicyApplied();
  await fixture.harness.redmine.writeAgentRunning();
  await fixture.harness.agent.start();
  const result = await fixture.harness.agent.run("changes_ready");
  fixture.harness.checkpointAfterAgentResult();
  await writeFile(join(fixture.workspace, "change.txt"), "change\n", "utf8");

  const patch = "diff --git a/change.txt b/change.txt\nnew file mode 100644\n--- /dev/null\n+++ b/change.txt\n@@ -0,0 +1 @@\n+change\n";
  const artifact = buildPhase49Artifact({
    executionId: EXECUTION_ID,
    issueId: ISSUE_ID,
    repository: "mcp-mamono210/ai-agent-runner",
    sourceRevision: "e".repeat(40),
    briefRevision: 1,
    persistedRevision: "phase50-8-cross-phase",
    requirementsFingerprint: `sha256:${"f".repeat(64)}`,
    outcome: result.outcome,
    changedFiles: [{ path: "change.txt", status: "added" }],
    patch: {
      text: patch,
      capturedBytes: Buffer.byteLength(patch, "utf8"),
      truncated: false,
    },
  });
  const persistence = new Phase49S3ArtifactPersistence({
    client: fixture.harness.s3,
    config: { region: "ap-northeast-1", bucket: BUCKET, prefix: PREFIX },
  });
  const persisted = await persistence.persistAndConfirm(artifact);
  fixture.harness.checkpointAfterArtifactPersistence();
  await fixture.harness.redmine.writeSuccessfulFinalization(result.outcome);

  assert.equal(fixture.harness.s3.hasObject(BUCKET, OBJECT_KEY), true);
  assert.equal(fixture.harness.redmine.snapshot().lifecycle, "Ready for Independent Verification");

  return Object.freeze({
    scenario: "successful-artifact",
    evidence: Object.freeze([
      fixture.harness.redmine.snapshot().lifecycle,
      fixture.harness.redmine.snapshot().outcome,
      persisted.artifactReference,
      String(fixture.lock.isHeld(ISSUE_ID)),
    ]),
  });
}

async function runFaultRejection(
  fixture: CrossPhaseFixture,
): Promise<ScenarioObservation> {
  fixture.harness.faults.arm("FI-14");
  let observed = "";
  try {
    await fixture.harness.formalAuthorizationGate();
    assert.fail("FI-14 must reject the formal authorization gate");
  } catch (error) {
    assert.ok(error instanceof Phase50InjectedFaultError);
    assert.equal(error.faultId, "FI-14");
    observed = error.faultId;
  }
  assert.deepEqual(fixture.harness.faults.observed(), ["FI-14"]);

  return Object.freeze({
    scenario: "fault-rejection",
    evidence: Object.freeze([
      observed,
      fixture.harness.redmine.snapshot().lifecycle,
      fixture.harness.redmine.snapshot().outcome,
    ]),
  });
}

async function runResourceBoundary(
  fixture: CrossPhaseFixture,
): Promise<ScenarioObservation> {
  fixture.harness.scenarios.set("SC-02", 16);
  fixture.harness.scenarios.set("SC-03", 4096);
  await fixture.harness.sandbox.applyNetworkPolicy();
  const result = await fixture.harness.agent.run("no_changes");
  await writeFile(join(fixture.workspace, "resource-probe.txt"), result.output, "utf8");

  assert.equal(result.output.length, 16);
  assert.equal(fixture.harness.sandbox.workspaceBytes(), 4096);

  return Object.freeze({
    scenario: "resource-boundary",
    evidence: Object.freeze([
      String(result.output.length),
      String(fixture.harness.sandbox.workspaceBytes()),
      result.outcome,
    ]),
  });
}

function normalize(
  observations: readonly ScenarioObservation[],
): readonly ScenarioObservation[] {
  return [...observations].sort((left, right) =>
    left.scenario.localeCompare(right.scenario),
  );
}
