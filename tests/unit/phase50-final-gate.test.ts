import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  assertExpectedFailureObservation,
  assertNoExpectedFailureMarkers,
  assertPhase50GoldenContractMatches,
  parsePhase50ExpectedFailureRegistry,
  parsePhase50GoldenContract,
  type Phase50ExpectedFailureEntry,
} from "../../src/verification/phase50-contract-baseline.js";
import {
  assertPhase50EnvironmentCoverageClosed,
  parsePhase50ConformanceRecord,
} from "../../src/verification/phase50-conformance.js";

void describe("Phase 50-8 final gate", () => {
  void it("keeps the golden contract closed and expected-failure count at zero", () => {
    const golden = parsePhase50GoldenContract(
      loadJson("docs/contracts/phase50-contract-baseline.json"),
    );
    assert.doesNotThrow(() => assertPhase50GoldenContractMatches(golden));

    const expectedFailures = parsePhase50ExpectedFailureRegistry(
      loadJson("docs/verification/phase50-expected-failures.json"),
    );
    assert.equal(expectedFailures.entries.length, 0);
    assert.doesNotThrow(() => assertNoExpectedFailureMarkers(expectedFailures));
  });

  void it("keeps XPASS fatal instead of silently accepting a healed expected failure", () => {
    const marker: Phase50ExpectedFailureEntry = Object.freeze({
      testIdentity: "phase50-final-gate.synthetic-marker",
      blockingDefectIssueId: 999999,
      expectedFailureReason: "synthetic expected reason",
      canonicalContractReference: "synthetic contract reference",
      detectedDate: "2026-09-21",
    });

    assert.throws(
      () => assertExpectedFailureObservation(marker, { kind: "unexpected_pass" }),
      /XPASS requires marker removal/u,
    );
  });

  void it("requires the committed S3 and sandbox conformance record to be coverage-closed", () => {
    const record = parsePhase50ConformanceRecord(
      loadJson("docs/verification/phase50-environment-conformance.json"),
    );
    assert.doesNotThrow(() => assertPhase50EnvironmentCoverageClosed(record.findings));

    const surfaces = new Set(record.findings.map((finding) => finding.surface));
    assert.equal(surfaces.has("s3"), true);
    assert.equal(surfaces.has("sandbox"), true);
    assert.equal(
      record.findings.some((finding) =>
        finding.classification !== "compatible" && finding.coverageExecuted !== true,
      ),
      false,
    );
  });

  void it("fixes real S3 and sandbox continuation policy for the release boundary", () => {
    const root = requireRecord(
      loadJson("docs/verification/phase50-real-infrastructure-policy.json"),
      "phase50 real infrastructure policy",
    );
    assert.equal(root.schemaVersion, 1);
    assert.equal(root.issueId, 5432);

    const realS3 = requireRecord(root.realS3, "realS3");
    assert.equal(realS3.policy, "mandatory-per-system-release");
    assert.equal(realS3.releaseGateCommand, "npm run verify:phase49:s3");

    const sandbox = requireRecord(root.sandbox, "sandbox");
    assert.equal(sandbox.policy, "mandatory-environment-conformance-per-system-release");
    assert.equal(sandbox.releaseGateCommand, "npm run verify:phase50:environment");
    assert.equal(sandbox.currentUnresolvedProductionEquivalentGap, false);
  });

  void it("contains no permanent Node test skip, todo, or xfail marker", () => {
    const testFiles = walkTypeScriptFiles(resolve("tests"));
    assert.ok(testFiles.length > 0);
    const permanentMarker = /(?:describe|it|test)\.(?:skip|todo)\s*\(|\bxfail\s*\(/u;

    for (const file of testFiles) {
      const content = readFileSync(file, "utf8");
      assert.doesNotMatch(content, permanentMarker, file);
    }
  });

  void it("closes the Phase 50 artifact handoff decision and records the Phase 51 boundary", () => {
    const artifactHandoff = readFileSync(
      resolve("docs/contracts/phase50-artifact-handoff.md"),
      "utf8",
    );
    const finalVerification = readFileSync(
      resolve("docs/phase50-final-verification.md"),
      "utf8",
    );

    assert.doesNotMatch(artifactHandoff, /Phase 50 decisions still open/u);
    assert.match(artifactHandoff, /Phase 50-7 restore closure/u);
    assert.match(artifactHandoff, /mandatory per system release/u);
    assert.match(finalVerification, /Phase 50-1 through Phase 50-8/u);
    assert.match(finalVerification, /Phase 51 handoff/u);
    assert.match(finalVerification, /Git push/u);
    assert.match(finalVerification, /automatic Agent retry/u);
  });
});

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function walkTypeScriptFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScriptFiles(path));
    } else if (entry.isFile() && extname(entry.name) === ".ts") {
      files.push(path);
    }
  }
  return files;
}
