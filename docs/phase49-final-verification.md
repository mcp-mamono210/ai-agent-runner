# Phase 49 Final Verification / Phase 50 Handoff

This document is the final verification procedure for Redmine issue #5422.
It consumes the Phase 49-1 through Phase 49-4 contracts without redefining them.

## 1. Production execution path

`createPhase49_5ProductionRuntime()` wires the production provisional result path as:

```text
Agent Running durable read-back
-> Agent provisional changes_ready | no_changes
-> collect local change-set before workspace disposal
-> canonical Phase 49 single-object artifact
-> direct conditional PutObject
-> HeadObject(ChecksumMode=ENABLED)
-> required metadata + FULL_OBJECT SHA-256 exact verification
-> artifact_reference
-> Redmine successful finalization
-> exact Redmine read-back
-> Ready for Independent Verification
```

The Agent never writes Redmine lifecycle state and is never automatically retried.
The local workspace and local patch remain transient.

## 2. Startup reconciliation ordering

Phase 49-5 reuses the Phase 48-6 startup reconciler. Therefore the order remains:

```text
Controller startup
-> remove owned sandbox containers
-> remove owned attempt workspaces
-> cleanup succeeds
-> query Agent Running executions
-> artifact-aware reconciliation
```

If cleanup fails, no artifact-aware reconciliation is attempted and polling does not start.

For each `Agent Running` execution:

```text
deterministic key from execution_id
-> HeadObject(ChecksumMode=ENABLED)
-> required metadata/checksum presence
-> GetObject(ChecksumMode=ENABLED)
-> canonical manifest + patch checksum verification
-> Redmine started identity == artifact manifest identity
-> metadata == canonical artifact projection
-> FULL_OBJECT SHA-256 exact match
```

Classification is fail closed:

```text
valid artifact
  -> successful finalization
  -> Ready for Independent Verification

explicit S3 not_found
  -> Phase 48 fallback
  -> interrupted / Needs Human

access_denied / missing checksum / missing metadata / corrupt body /
manifest mismatch / metadata mismatch / checksum mismatch / unreadable object
  -> no successful reconciliation
  -> no interrupted reinterpretation
  -> startup reconciliation remains unconfirmed
```

A 403 is never interpreted as artifact absence. This is important because the
Controller intentionally has no `ListBucket` permission.

## 3. Source-of-Truth boundary

```text
Redmine       = durable execution lifecycle SoT
private S3    = durable artifact SoT
Application Git = application source SoT
S3 body manifest = canonical artifact identity
S3 metadata   = bounded verification projection only
workspace / local patch / local lock = transient
```

Recovery does not use mutable Redmine fields to retarget an execution and does
not require the original workspace or a locally reserialized patch.

`recoverAndVerify()` reconstructs the typed artifact only after the fetched S3
body has passed canonical-body and patch-checksum validation. This reconstruction
is a full-body verification step; it is not a prerequisite for conditional-write
idempotency.

## 4. Unit verification

Run:

```bash
npm run lint &&
npm run typecheck &&
npm run test:unit
```

Phase 49-5 unit coverage includes:

- deterministic existing-artifact recovery without `ListBucket`;
- missing checksum fail closed;
- missing metadata fail closed;
- metadata/body mismatch rejection;
- Redmine started-identity mismatch rejection;
- durable `no_changes` empty artifact recovery;
- explicit `not_found` preservation for the Phase 48 interrupted fallback;
- valid artifact startup success reconciliation;
- access-denied/invalid artifact not reinterpreted as absence;
- production provisional handoff before workspace disposal;
- real-S3 verification harness behavior, including ambiguous remote-success recovery.

## 5. Real private S3 final verification

Use a dedicated private verification prefix. Do not use a shared production
execution ID. The verifier intentionally does not request `DeleteObject`; test
objects are left for the configured lifecycle policy.

Required runtime variables are the normal Phase 49 S3 variables plus:

```text
PHASE49_REAL_S3_TESTED_GIT_REVISION=<full lowercase Git commit>
PHASE49_REAL_S3_REPOSITORY=mcp-mamono210/ai-agent-runner
PHASE49_REAL_S3_ISSUE_ID=5422
PHASE49_REAL_S3_RETENTION_DAYS=30
PHASE49_REAL_S3_IAM_BOUNDARY_CONFIRMED=yes
PHASE49_REAL_S3_VERIFICATION_RECORD=docs/verification/phase49-real-s3-YYYYMMDD.json
```

Set `AGENT_RUNNER_ARTIFACT_S3_PREFIX` to a dedicated verification prefix, for example:

```text
phase49/verification/2026-09-21
```

Before setting `PHASE49_REAL_S3_IAM_BOUNDARY_CONFIRMED=yes`, independently verify
the Controller credential/policy permits the required object operations and does
not grant the excluded operations:

```text
required: s3:PutObject, s3:GetObject
excluded: s3:DeleteObject, s3:ListBucket
```

Also verify the bucket lifecycle retains completed artifacts for at least 30 days.

Run:

```bash
npm run verify:phase49:s3
```

The command refuses to write a PASS record when retention is below the Phase 49
minimum or the IAM boundary has not been explicitly attested.

The real-S3 harness verifies:

```text
direct PutObject
If-None-Match: *
SHA-256 FULL_OBJECT
HeadObject ChecksumMode=ENABLED
GetObject ChecksumMode=ENABLED
required metadata exact read-back
lowercase kebab-case metadata projection
ASCII-safe metadata values
SSE-S3 AES256
versioning-disabled observation
changes_ready artifact
no_changes durable empty artifact
incompatible second PutObject rejected
ambiguous remote-success -> matching object adopted
deterministic recovery without workspace/ListBucket
```

The generated JSON record contains no AWS credentials, Redmine API keys, provider
keys, repository credentials, or control-plane secrets.

## 6. Close gate for #5422

Do not close #5422 only from unit-test success. Close only after all of the
following are true:

```text
lint PASS
typecheck PASS
unit tests PASS
real private S3 verification PASS
verification JSON record saved
IAM boundary reviewed
retention >= 30 days confirmed
Phase 49 First-write Compatibility Gate (#5423) remains PASS
```

The final verification record must identify the tested Git revision, region,
bucket/test prefix, artifact contract version, checksum mode, metadata size,
retention, IAM attestation, scenarios, and result.
