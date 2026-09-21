# Phase 49-4 Successful Redmine Finalization Contract

This document fixes the v0.4.0 successful-finalization boundary for Redmine issue #5421.
It consumes the artifact contract from #5418, the confirmed S3 persistence path from #5419,
and the canonical `no_changes` artifact contract from #5420.

## 1. First-write compatibility precondition

The Phase 49 First-write Compatibility Gate was completed with disposable fixture
Issue #5423 on the production Redmine instance before Phase 49-4 implementation.
The gate proved exact write/read-back for:

```text
Agent Execution Lifecycle = Ready for Independent Verification
Agent Execution Outcome = artifact_persistence_failed
Agent Artifact Reference = production-format s3:// reference
```

The production finalizer does not re-run that fixture check during normal execution.

## 2. Successful finalization ordering

The only successful ordering is:

```text
Phase 48 provisional result
-> canonical Phase 49 artifact construction
-> Phase49S3ArtifactPersistence.persistAndConfirm
   -> direct conditional PutObject
   -> HeadObject(ChecksumMode=ENABLED)
   -> required metadata presence and exact comparison
   -> required FULL_OBJECT SHA-256 presence and exact comparison
   -> started execution identity projection confirmed
-> durable artifact_reference available
-> Redmine successful finalization write
-> Redmine exact read-back
-> Ready for Independent Verification confirmed
```

`Phase49SuccessfulFinalizationCoordinator` owns this ordering. It cannot call the
successful Redmine finalizer before `persistAndConfirm` resolves.

A successful PutObject response alone is not sufficient. Missing checksum,
missing required metadata, identity mismatch, checksum mismatch, or any other
failure returned by the Phase 49 persistence layer prevents successful Redmine
finalization.

## 3. Successful durable Redmine state

After successful finalization, Redmine contains:

```text
Agent Execution Lifecycle = Ready for Independent Verification
Agent Execution Finished At = canonical RFC3339 timestamp
Agent Execution Outcome = changes_ready | no_changes
Agent Artifact Reference = confirmed durable s3:// reference
```

The started execution identity remains unchanged:

```text
Agent Execution ID
Agent Exec Brief Revision
Agent Exec Persisted Revision
Agent Exec Req Fingerprint
Agent Execution Repository
Agent Exec Source Revision
Agent Execution Started At
```

The finalizer verifies the active `Agent Running` identity before the write and
re-verifies the same identity after the write.

## 4. Read-back confirmation

A successful Redmine request is not completion by itself.

After exactly one successful-finalization write attempt, the finalizer re-fetches
the Issue and requires exact scalar read-back for:

```text
expected execution identity
Ready for Independent Verification
expected canonical outcome
expected artifact_reference
expected finished_at
```

Missing, normalized, stale, ambiguous, or mismatched values fail closed.

## 5. changes_ready and no_changes

Both outcomes use the same storage and finalization architecture.

`changes_ready` uses the ordinary Phase 49 single-object artifact builder.

`no_changes` uses the Phase 49-3 canonical empty artifact builder and still
produces a real durable object before Redmine success finalization. Artifact
absence is never interpreted as `no_changes`.

## 6. Artifact-pipeline failure

Artifact construction or persistence confirmation failure is finalized with the
Phase 49-1 canonical failure taxonomy:

```text
Agent Execution Lifecycle = Needs Human
Agent Execution Finished At = populated
Agent Execution Outcome = artifact_persistence_failed
Agent Artifact Reference = ""
```

No Phase 49-4-specific durable outcome is introduced. Detailed internal causes
remain implementation diagnostics/reason codes; they do not expand the Redmine
outcome taxonomy.

The failure write is attempted once and then read back exactly. If failure
finalization cannot be confirmed, the Issue may remain `Agent Running`, matching
the existing Phase 48 fail-safe boundary.

## 7. Successful-finalization write failure

Once `persistAndConfirm` has returned, a valid durable artifact exists.

If the subsequent Redmine successful-finalization write or read-back cannot be
confirmed:

```text
no Agent retry
no second successful-finalization write in the same attempt
no conversion to artifact_persistence_failed
error propagates
Phase 49-5 owns reconciliation
```

This preserves the distinction between an artifact pipeline failure and an
interrupted Redmine finalization after durable artifact creation.

## 8. Writer ownership

The Controller remains the execution lifecycle writer. The Agent does not write
Redmine lifecycle, finished time, outcome, or artifact reference.

Phase 49-4 does not introduce another lifecycle authority.

## 9. Scope boundary

Phase 49-4 does not implement:

```text
artifact-aware startup reconciliation
real private S3 final verification
restore E2E
CI feedback
Git push
Pull Request
automatic Agent retry
periodic reconciliation
```

Those cross-cutting verification and recovery responsibilities remain Phase 49-5
or later work.

## 10. Unit verification

The Phase 49-4 unit tests cover at least:

```text
changes_ready successful finalization
no_changes successful finalization
persistence before Redmine success ordering
missing checksum -> success prohibited
missing required metadata -> success prohibited
envelope SHA-256 mismatch -> success prohibited
stale started identity -> success prohibited
artifact_persistence_failed write/read-back
successful-finalization write failure -> no retry / no failure rewrite
Redmine request success + read-back mismatch -> completion prohibited
failure-finalization write failure -> Agent Running may remain
invalid no_changes -> canonical artifact failure outcome
```

Full artifact-aware restart reconciliation and real private S3 verification remain
owned by #5422 / Phase 49-5.
