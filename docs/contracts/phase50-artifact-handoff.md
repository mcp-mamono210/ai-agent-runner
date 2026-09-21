# Phase 50 Artifact Handoff Contract

This document fixes the Phase 49 -> Phase 50 artifact boundary established by
Redmine issue #5422. Phase 50 consumes the existing Phase 49 single-object
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

## Phase 50 decisions still open

Phase 50 may decide how long real-S3 verification remains a release gate and how
artifact restore is integrated into independent verification. It must not change
these Phase 49 decisions without an explicit contract revision:

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
