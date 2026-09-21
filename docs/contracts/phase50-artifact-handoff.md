# Phase 50 Artifact Handoff Contract

This document fixes the Phase 49 -> Phase 50 artifact boundary established by
Redmine issue #5422 and closes the Phase 50 artifact handoff decisions through
Phase 50-8 (#5432). Phase 50 consumes the existing Phase 49 single-object
architecture; it does not introduce another artifact format or storage SoT.

## Durable inputs available to Phase 50

For a successfully finalized execution, Phase 50 can deterministically obtain:

```text
execution_id
issue_id
repository
source_revision
brief_revision
persisted_revision
requirements_fingerprint
outcome = changes_ready | no_changes
artifact_reference
canonical manifest
serialized patch
patch SHA-256
artifact-envelope SHA-256
```

Redmine supplies the durable execution lifecycle projection. The canonical
artifact identity and serialized patch come from the S3 object body manifest and
body. S3 user metadata is verification projection only.

## Deterministic retrieval

```text
execution_id
-> configured private S3 bucket/prefix
-> <prefix>/<execution_id>.json
-> HeadObject(ChecksumMode=ENABLED)
-> GetObject(ChecksumMode=ENABLED)
-> canonical body validation
```

No `ListBucket`, workspace, local patch, local lock, branch head, tag, or latest
mutable application state is required.

## Required validation before Phase 50 use

Phase 50 must fail closed on:

```text
artifact absent when an artifact is required
checksum missing
required metadata missing/null/undefined
metadata field-set mismatch
metadata/manifest mismatch
artifact-envelope SHA-256 mismatch
patch SHA-256 mismatch
manifest corruption
source_revision mismatch
Brief identity mismatch
requirements fingerprint mismatch
execution_id / issue_id mismatch
unsupported artifact format
```

`no_changes` is represented by the same durable single-object format with the
canonical empty patch. Artifact absence is not `no_changes`.

## Recovery classifications inherited from Phase 49

```text
Controller interruption + valid artifact
  -> successful Redmine reconciliation
  -> Ready for Independent Verification

Controller interruption + explicit artifact not_found
  -> interrupted / Needs Human

Controller interruption + invalid/unreadable/unverifiable artifact
  -> fail closed
  -> never successful reconciliation
```

## Phase 50-7 restore closure

Phase 50-7 closes the restore behavior that Phase 49 handed forward:

```text
clean checkout
+ exact source_revision
+ durable artifact
-> canonical artifact verification
-> patch checksum verification
-> exact serialized patch extraction
-> git apply --check
-> change-set restore
```

Restore does not retarget to a mutable branch HEAD and does not require the
original Workspace. `no_changes` is restored and verified through the same
non-absent durable artifact path.

An invalid artifact remains an independent-verification failure. Phase 50 does
not reinterpret an invalid artifact as PASS merely because Redmine already holds
`Ready for Independent Verification`, and it does not introduce a new lifecycle
rollback writer in the restore path.

## Phase 50-8 continuation policy

The real infrastructure policy is fixed in:

```text
docs/verification/phase50-real-infrastructure-policy.json
```

Real private S3 verification is **mandatory per system release**. The existing
real-S3 verifier remains the release evidence source:

```bash
npm run verify:phase49:s3
```

Change-triggered or scheduled real-S3 runs may be added as supplemental evidence,
but they do not replace the system-release gate. This keeps conditional-write,
FULL_OBJECT checksum, metadata, IAM, encryption, and lifecycle drift observable
even when application source has not changed in the same area.

The sandbox/environment gate is also required for the system release:

```bash
npm run verify:phase50:environment
```

The committed conformance record currently has no unresolved production-equivalent
contract gap. If a future conformance record contains `incompatible`,
`unsupported`, or `different-contract-affecting` semantics, the applicable
coverage route A-D must be executed and evidenced before release PASS. Mandatory
semantics are never silently skipped.

## Fixed Phase 49 decisions

Phase 50 verification and Phase 51 release preparation must not change these
Phase 49 decisions without an explicit contract revision:

```text
single-object artifact
direct conditional PutObject
SHA-256 FULL_OBJECT
HeadObject/GetObject checksum-enabled verification
deterministic execution_id-derived object key
private S3 durable artifact SoT
Redmine durable lifecycle SoT
no ListBucket requirement
no Controller DeleteObject permission
no automatic Agent retry
```

## Phase 51 handoff boundary

Phase 51 consumes the verified Phase 50 boundary. It may perform release
preparation and cross-component compatibility verification, but it does not use
this handoff as authority to redesign execution identity, lifecycle ownership,
artifact format, storage SoT, or restore semantics.
