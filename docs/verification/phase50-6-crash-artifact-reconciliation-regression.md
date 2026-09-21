# Phase 50-6 Crash / Artifact-aware Reconciliation / Same-run Artifact Conflict Regression

Issue: #5430

This suite fixes restart-time convergence as a function of durable Redmine state
and durable artifact state. It consumes the Phase 50-2 deterministic controls
without adding another recovery authority or a local durable execution journal.

## Production boundaries under regression

- `Phase48_6StartupReconciler`
  - transient cleanup completes before Agent Running enumeration;
  - cleanup failure prevents both reconciliation and normal Controller polling.
- `Phase49ArtifactAwareExecutionReconciler`
  - reads the immutable Agent Running identity from Redmine;
  - uses deterministic artifact recovery;
  - selects the interrupted fallback only for explicit S3 `not_found`;
  - does not treat access denial, unreadable objects, corruption, or identity
    mismatch as artifact absence.
- `Phase49S3ArtifactPersistence`
  - recovery uses deterministic execution-ID addressing plus Head/Get;
  - same-run ambiguous/conflict handling adopts an object only after exact
    checksum/metadata confirmation;
  - recovery has no workspace, local patch, or ListBucket dependency.
- `RedminePhase49ExecutionFinalizer`
  - a verified recovered artifact completes the original started execution as
    `Ready for Independent Verification`.
- `RedmineInterruptedExecutionFinalizer`
  - explicit absence converges the original started execution to
    `Needs Human + interrupted` without retrying the Agent.

## Startup ordering

The regression asserts:

```text
cleanup
-> Agent Running enumeration
-> reconciliation
-> normal polling
```

A cleanup failure stops before enumeration and before Controller polling. The
existing `DockerWorkspaceOrphanCleaner` remains the production owner of owned
sandbox cleanup followed by owned workspace cleanup.

## Durable state matrix

### Agent Running x artifact absent

Only explicit `Phase49S3OperationError(kind = not_found)` selects the absent
artifact fallback:

```text
Agent Running + not_found
-> Needs Human + interrupted
```

There is no Agent retry and no attempt to reconstruct a prior non-durable
`agent_failed`, `timeout`, or `agent_start_failed` observation.

### Agent Running x valid artifact

Both artifact outcomes are real durable objects:

```text
changes_ready -> Ready for Independent Verification + changes_ready
no_changes    -> Ready for Independent Verification + no_changes
```

`no_changes` is never interpreted as artifact absence.

### Non-Agent-Running durable states

`Ready for Independent Verification`, `Needs Human`, and `Ready for Agent` are
not accepted by the artifact-aware Agent Running reconciler. Recovery is not
entered and their lifecycle is not rolled back or promoted merely because an
artifact exists.

## Phase 50 fault controls consumed

| Control | Regression |
| --- | --- |
| FI-06 | interruption after Agent result and before artifact -> restart sees Agent Running x absent -> interrupted |
| FI-08 | PutObject remote success + ambiguous client result -> conditional conflict/Head confirmation -> matching object adopted |
| FI-09 | interruption after durable artifact and before Redmine success -> restart verifies the existing artifact and finalizes success |
| FI-12 | HeadObject fault propagates fail-closed and does not select not_found |
| FI-13 | GetObject fault propagates fail-closed and does not select not_found |

FI-08 uses the Phase 50 fault controller with an explicit
`Phase49S3OperationError(kind = ambiguous)` so the production persistence path
exercises the real recoverable-error contract rather than merely catching a
generic test exception.

## Restart-time mutable state

SC-04 / SC-05 / SC-06 are applied while the simulated Controller is stopped.
Current requirements, latest Brief revision, and branch HEAD are changed, while
Redmine and the durable artifact retain the original started identity.

Reconciliation succeeds only from:

```text
execution_id
issue_id
repository
source_revision
brief_revision
persisted_revision
requirements_fingerprint
```

stored durably for the started execution. The test asserts that the newer
mutable values do not retarget recovery.

## Invalid / unverifiable artifact policy

The suite verifies category-specific expected failure reasons and asserts that
successful reconciliation and the explicit-not-found fallback are both
unreachable for each case. Coverage includes:

- checksum missing;
- metadata missing as `undefined` or `null`;
- required metadata value missing;
- non-ASCII / invalid metadata representation;
- metadata mismatch and metadata/manifest mismatch;
- artifact-envelope checksum mismatch;
- patch checksum mismatch;
- corrupt manifest;
- unsupported artifact format;
- source revision mismatch;
- Brief identity mismatch;
- requirements fingerprint mismatch;
- execution ID mismatch;
- issue ID mismatch;
- unreadable object;
- access denied;
- malformed/corrupt body.

SC-07 is also consumed directly through the Phase 50 harness to verify corrupt
body behavior.

The regression does not pass all invalid cases through one generic exception.
It checks the expected production error category for every fixture and verifies
that Redmine remains `Agent Running` with no successful outcome.

## Recovery inputs and prohibited dependencies

The recovery test constructs only durable Redmine identity plus durable S3
state. It supplies no original workspace and no local patch. The S3 test client
records operations and asserts:

```text
PutObject = 0
HeadObject = 1
GetObject = 1
ListBucket = 0
```

for restart recovery. This preserves Redmine and S3 as the durable recovery
inputs and keeps local process/workspace state transient.

## Verification

Run the complete Phase 50 environment gate:

```bash
npm run verify:phase50:environment
```

For code-only iteration:

```bash
npm run lint &&
npm run typecheck &&
npm run test:unit
```

The existing Phase 50-1 golden guards remain part of `test:unit`.
