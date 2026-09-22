import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const SCRIPTS = [
  "common.mjs",
  "agent-runner-consumer-profile.mjs",
  "agent-runner-handoff-validation-probe.mjs",
  "agent-runner-requirements-fingerprint-probe.mjs",
  "agent-runner-phase50-baseline-probe.mjs",
  "classify-agent-runner-rc-change.mjs",
  "verify-agent-runner-rc-support.mjs",
  "collect-agent-runner-rc-evidence-input.mjs",
].map((name) => resolve(ROOT, "scripts/phase51", name));

function canonicalProfile() {
  return {
    schemaVersion: 1,
    profileId: "ready-for-agent-handoff-v1",
    lifecycle: { fieldName: "Agent Brief Lifecycle", readyForAgentValue: "Ready for Agent" },
    approval: {
      approvedBy: { fieldName: "Brief Approved By", constraint: { constraintId: "redmine-principal-v1", valueType: "string", required: true, representation: "redmine-user:<positive-base10-integer>", pattern: "^redmine-user:[1-9][0-9]*$", allowEmpty: false } },
      approvedAt: { fieldName: "Brief Approved At", constraint: { constraintId: "rfc3339-offset-timestamp-v1", valueType: "string", required: true, representation: "RFC3339 timestamp with Z or numeric offset", format: "rfc3339-offset-timestamp", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$", allowEmpty: false } },
      approvedBriefRevision: { fieldName: "Approved Brief Revision", constraint: { constraintId: "positive-safe-base10-integer-v1", valueType: "string", required: true, representation: "positive base-10 integer without sign or leading zero", pattern: "^[1-9][0-9]*$", minimum: 1, allowEmpty: false } },
      approvedPersistedRevision: { fieldName: "Approved Persisted Revision", constraint: { constraintId: "nonblank-opaque-string-v1", valueType: "string", required: true, representation: "opaque nonblank string", allowEmpty: false } },
      approvedRequirementsFingerprint: { fieldName: "Approved Req Fingerprint", constraint: { constraintId: "sha256-lowercase-hex-v1", valueType: "string", required: true, representation: "sha256:<64 lowercase hexadecimal characters>", pattern: "^sha256:[0-9a-f]{64}$", allowEmpty: false } },
    },
    customFieldSemantics: { scalarRequired: true, uniqueExactNameRequired: true },
    handoffIdentity: { requiredFields: ["repository", "redmine_issue_id", "brief_revision", "persisted_revision", "requirements_fingerprint", "approver_identity", "approved_at"] },
    requirementsFingerprint: { contractId: "agent-brief-requirements-fingerprint", format: "sha256:<64 lowercase hexadecimal characters>", inputFormatVersion: 1, canonicalizationSemantics: "Phase 39 canonical JSON serialization derived from the bounded Phase 36 generation input; SHA-256 over UTF-8 bytes; updated_on is not a freshness signal" },
    constraints: {
      "redmine-principal-v1": { valueType: "string", positive: ["redmine-user:1", "redmine-user:42"], negative: ["", "redmine-user:0", "redmine-user:-1", "Redmine-user:42", "user:42"] },
      "rfc3339-offset-timestamp-v1": { valueType: "string", positive: ["2026-09-22T00:00:00Z", "2026-09-22T09:00:00+09:00", "2026-09-22T09:00:00.123+09:00"], negative: ["", "2026-09-22", "2026-09-22T09:00:00", "2026/09/22 09:00:00+09:00"] },
      "positive-safe-base10-integer-v1": { valueType: "string", positive: ["1", "42", "9007199254740991"], negative: ["", "0", "-1", "+1", "01", "1.0", "9007199254740992"] },
      "nonblank-opaque-string-v1": { valueType: "string", positive: ["opaque-persisted-revision", "a"], negative: ["", " ", "\t", "\n"] },
      "sha256-lowercase-hex-v1": { valueType: "string", positive: [`sha256:${"a".repeat(64)}`], negative: ["", "a".repeat(64), `sha256:${"A".repeat(64)}`, "sha256:abc", `sha256:${"g".repeat(64)}`] },
    },
    contractReferences: [
      { contractId: "agent-brief-release-handoff", semanticRevision: 1 },
      { contractId: "agent-brief-lifecycle", semanticRevision: 1 },
      { contractId: "agent-brief-redmine-mapping", semanticRevision: 1 },
      { contractId: "agent-brief-requirements-fingerprint", semanticRevision: 1 },
    ],
  };
}

function runScript(script: string, args: readonly string[]): string {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseJsonRecord(text: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(text) as unknown;
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed as Readonly<Record<string, unknown>>;
}

function recordField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = record[key];
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Readonly<Record<string, unknown>>;
}

void test("Phase 51-3 verification-support scripts are syntactically valid", () => {
  for (const script of SCRIPTS) {
    execFileSync(process.execPath, ["--check", script], { cwd: ROOT, stdio: "pipe" });
  }
});

void test("Phase 51-3 documentation states the Phase 50-complete boundary without becoming canonical compatibility SoT", () => {
  const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
  const normalizedReadme = readme.replace(/\s+/gu, " ");
  const changelog = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8");
  assert.match(normalizedReadme, /Current Phase 50 completion \/ Phase 51 RC boundary/u);
  assert.match(normalizedReadme, /Ready for Independent Verification/u);
  assert.match(normalizedReadme, /Phase 51 RC evidence is canonical in `mcp-mamono210\/redmine`/u);
  assert.match(normalizedReadme, /automatic Agent retry/u);
  assert.match(changelog, /Phase 50/u);
});

void test("consumer profile derivation binds the canonical profile to production handoff source", () => {
  const temp = mkdtempSync(join(tmpdir(), "phase51-profile-"));
  try {
    const profilePath = join(temp, "profile.json");
    writeFileSync(profilePath, `${JSON.stringify(canonicalProfile(), null, 2)}\n`);
    const output = runScript(resolve(ROOT, "scripts/phase51/agent-runner-consumer-profile.mjs"), [
      "--root",
      ROOT,
      "--canonical-profile",
      profilePath,
    ]);
    assert.deepEqual(parseJsonRecord(output), canonicalProfile());
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

void test("full RC support verification exercises production validation vectors and Phase 50 baseline", () => {
  const temp = mkdtempSync(join(tmpdir(), "phase51-support-"));
  try {
    const profilePath = join(temp, "profile.json");
    const producerPath = join(temp, "producer.json");
    writeFileSync(profilePath, `${JSON.stringify(canonicalProfile(), null, 2)}\n`);
    writeFileSync(
      producerPath,
      `${JSON.stringify({ current: { requirementsFingerprintImplementationSources: [
        { repository: "mcp-mamono210/redmine", sourceRevision: "2b2bd1c42f1caaf876da02da0adc67dd698ddff4", path: "src/agent-brief/generation-input.ts", blobSha: "a99b84a72eb4bcd21137121ae996ba700608f67c" },
        { repository: "mcp-mamono210/redmine", sourceRevision: "2b2bd1c42f1caaf876da02da0adc67dd698ddff4", path: "src/agent-brief/requirements-fingerprint.ts", blobSha: "4b0f174f12552f7bf7f4882b917e0276a5fff0c5" },
      ] } }, null, 2)}\n`,
    );
    const output = runScript(resolve(ROOT, "scripts/phase51/verify-agent-runner-rc-support.mjs"), [
      "--root",
      ROOT,
      "--canonical-profile",
      profilePath,
      "--producer-verification",
      producerPath,
    ]);
    const result = parseJsonRecord(output);
    assert.equal(result.result, "PASS");
    assert.equal(recordField(result, "constraintConformance").result, "PASS");
    assert.equal(recordField(result, "phase50Baseline").result, "PASS");
    assert.equal(recordField(result, "documentationReadiness").readme, "PASS");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
