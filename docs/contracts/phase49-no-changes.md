# Phase 49-3 no_changes / Empty Artifact Contract

This document fixes the v0.4.0 `no_changes` semantics for Redmine issue #5420.
It consumes the Phase 49-1 single-object contract and Phase 49-2 S3 persistence
runtime without creating a separate storage architecture.

## 1. Semantic meaning

`no_changes` means:

```text
Agent completed normally
+ validated change-set is empty
```

It does **not** mean that no artifact exists.

A successful `no_changes` execution produces one normal durable Phase 49 artifact
at the deterministic execution-ID-derived S3 address.

## 2. Canonical empty patch

The canonical serialized patch representation is exactly the empty UTF-8 byte
sequence:

```text
""
```

Its SHA-256 is fixed:

```text
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

The artifact envelope itself is not empty. It contains the canonical manifest,
execution identity, `outcome = no_changes`, changed-files `[]`, patch contract,
and the serialized empty patch field.

Therefore:

```text
empty patch != artifact absent
```

## 3. Validation boundary

The Phase 49-3 builder accepts only:

```text
provisional outcome = no_changes
changed files        = []
patch text           = ""
patch captured bytes = 0
patch truncated      = false
```

The following fail closed before persistence:

```text
changes_ready passed to no_changes builder
no_changes + changed files
no_changes + non-empty patch
no_changes + inconsistent captured byte count
no_changes + truncated patch capture
```

Detailed validation failures keep the Phase 49-1 durable outcome decision:

```text
artifact_persistence_failed
```

No new Redmine outcome value is introduced by #5420.

## 4. Persistence and integrity

`no_changes` uses `Phase49S3ArtifactPersistence` unchanged:

```text
canonical single artifact
-> direct PutObject
   If-None-Match: *
   SHA-256 FULL_OBJECT
-> HeadObject
   ChecksumMode = ENABLED
-> required metadata / checksum / identity verification
-> durable artifact confirmed
```

The same conflict/ambiguous-write recovery is used. A matching existing object
may be adopted only after checksum-enabled HeadObject proves the expected
metadata identity and envelope SHA-256. Missing verification data fails closed.

There is no no_changes-specific bucket, key scheme, uploader, or recovery path.

## 5. Full verification

When canonical-body verification is required, the existing Phase 49-2 path is
used:

```text
GetObject(ChecksumMode=ENABLED)
-> storage observation verification
-> canonical body verification
-> no_changes semantic verification
```

The final semantic check requires:

```text
manifest outcome = no_changes
changed files    = []
patch            = ""
patch SHA-256    = canonical empty SHA-256
```

A self-consistent but non-empty patch presented as `no_changes` is rejected by
the Phase 49-3 semantic verifier.

## 6. Independent Verification handoff

After persistence confirmation, the bounded handoff preserves at least:

```text
execution_id
issue_id
repository
source_revision
brief_revision
persisted_revision
requirements_fingerprint
outcome = no_changes
artifact_reference
canonical manifest
canonical empty patch representation
empty patch checksum
envelope checksum
```

This is sufficient for Independent Verification to retrieve and reason about a
normal durable artifact without treating absence as success.

## 7. Ownership boundary

#5420 does not own:

- successful Redmine lifecycle finalization;
- transition to `Ready for Independent Verification`;
- startup reconciliation;
- Phase 50 restore E2E;
- CI or PR creation.

Those remain later Phase 49 / Phase 50 responsibilities.

## 8. Verification coverage

Unit coverage for #5420 proves:

- non-absent artifact generation for `no_changes`;
- fixed canonical empty patch and SHA-256;
- rejection of `changes_ready` at this boundary;
- rejection of changed files or non-empty patch under `no_changes`;
- reuse of Phase 49-2 conditional PutObject and checksum-enabled HeadObject;
- reuse of GetObject full verification;
- reuse of ambiguous-write recovery;
- fail-closed behavior when required checksum data is missing;
- preservation of Independent Verification handoff data;
- no lifecycle transition in this contract layer.
