# Phase 48 Final Verification

Status: development verification record for the unreleased v0.4.0 milestone.

This document is not a second canonical system contract. Canonical Agent Runner
architecture, execution-input, and security contracts remain in
`mcp-mamono210/redmine`:

```text
docs/contracts/agent-runner-execution-boundary-contract.md
docs/contracts/agent-runner-execution-input-contract.md
docs/contracts/agent-runner-security-sandbox-contract.md
040_ロードマップ
```

Phase 48 implementation must consume those contracts without redefining their
identity, ordering, lifecycle ownership, or security boundaries.

## Deployment-level decisions used by Phase 48

```text
local duplicate-prevention lock:
  process-local / in-memory

sandbox runtime:
  Docker Engine

Agent provider:
  Codex CLI

initial topology:
  Controller = 1
  Worker = 1
  concurrent execution = 1
```

The process-local lock disappears on restart and is never a durable claim,
queue, execution history, or Source of Truth.

## Verified execution ordering

The implementation preserves the following order:

```text
Ready for Agent candidate
-> local lock
-> Issue re-fetch
-> Phase 46 handoff / eligibility validation
-> requirements revalidation
-> Phase 46 repository identity
-> Phase 47 early allowlist pre-check
-> authorized repository access only
-> exact source revision fixed
-> formal Phase 47 authorization / security gate
-> execution preparation
-> execution_id
-> immutable execution input
-> logical execution record
-> Agent Running durable mutation + exact confirmation
-> task-scoped workspace
-> fixed-revision checkout
-> fresh sandbox
-> Agent Adapter
-> one-shot Agent execution
-> provisional result or started-failure finalization
-> sandbox / workspace cleanup
-> local lock release
```

The early repository allowlist pre-check and the formal Phase 47 gate remain
separate. No `execution_id` is allocated before the formal gate succeeds. The
Agent is not started before the durable `Agent Running` mutation has been
confirmed by exact read-back.

## Pre-execution failure boundary

The regression suite verifies the existing failure identities without creating
an execution attempt:

```text
requirements mismatch -> stale_requirements
other handoff / eligibility failure -> eligibility_failed
early repository authorization / source preparation failure -> eligibility_failed
formal authorization failure -> eligibility_failed
```

For these cases:

```text
execution_id = not allocated
Agent Running = not written
Agent = not started
```

## Started-execution failure boundary

Phase 48-5 and Phase 48-6 together implement:

```text
agent_start_failed
timeout
agent_failed
interrupted
```

Started failure finalization preserves the immutable execution identity and
writes, with read-back confirmation:

```text
Agent Execution Lifecycle = Needs Human
Agent Execution Finished At = populated
Agent Execution Outcome = exact canonical outcome
Agent Artifact Reference = empty
```

A failed, rejected, ambiguous, partial, or unverifiable failure-finalization
write is not retried blindly. If Redmine still says `Agent Running`, cleanup is
performed and the next startup reconciliation may durably finalize the execution
as `interrupted`. This is durable state reconciliation retry, not Agent retry.

## Redaction verification

Phase 48-5 defines the reusable redaction component. Phase 48-6 reuses the same
component for interruption, reconciliation, cleanup-failure, and orphan-resource
diagnostics. A redaction failure suppresses raw potentially secret-bearing
content rather than persisting it.

Phase 50 still owns the full deterministic secret-fixture regression matrix.

## Development Walking Skeleton success boundary

Phase 48-7 captures a transient handoff before the task workspace is disposed:

```text
execution_id
issue_id
repository
exact source revision
Brief revision
persisted revision
requirements fingerprint
provisional changes_ready / no_changes
changed-file information
bounded local patch / change-set abstraction
bounded execution summary
```

The handoff is an in-memory development checkpoint. It is not a durable artifact
or a second Source of Truth.

A successful Phase 48 Walking Skeleton intentionally does not perform:

```text
Ready for Independent Verification
successful artifact_reference
production successful execution finalization
private S3 persistence
artifact manifest / checksum
```

Those remain Phase 49 responsibilities.

## Development fixture reset policy

After a disposable Walking Skeleton verification, test state is reset through an
explicit development-only `DevelopmentFixtureReset` port or an equivalent
fixture reseed / disposable Issue recreation mechanism.

The reset is not a production Agent Controller lifecycle transition. The
production Controller does not roll a successful provisional `Agent Running`
execution back to `Ready for Agent`.

If fixture reset is intentionally omitted and the Controller restarts while the
Issue still has `Agent Running` and no durable Phase 49 result, the expected
fail-safe behavior is:

```text
Agent Running
-> startup reconciliation
-> interrupted
-> Needs Human
```

This is not treated as a reconciliation bug.

## Phase 49 handoff boundary

Phase 49 can start from the Phase 48-7 handoff without adding a new execution
runtime architecture. It adds durable result semantics only:

```text
artifact manifest
patch serialization
checksum
private S3 persistence
artifact_reference
successful Redmine finalization
Ready for Independent Verification
```

The local patch / workspace remains transient until Phase 49 makes the result
durable and verifies its identity / integrity.

## Explicitly excluded from Phase 48

```text
Git remote push
CI feedback loop
Pull Request creation
merge automation
deployment automation
distributed Worker / Runner execution
distributed claim / lease / heartbeat
automatic Agent retry
```
