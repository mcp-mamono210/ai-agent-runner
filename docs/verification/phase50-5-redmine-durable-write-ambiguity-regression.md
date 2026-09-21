# Phase 50-5 Redmine Durable-write / Finalization Ambiguity Regression

Issue: #5429

This regression fixes the write-time boundary for Redmine execution lifecycle
mutations. It consumes the Phase 50-2 FI-01 / FI-02 / FI-10 / FI-11 controls
and exercises the existing production writer/finalizer components rather than
introducing a second lifecycle implementation.

## Scope

Phase 50-5 owns only the result visible at the end of the current write attempt:

```text
write attempt
-> exact confirmation result
-> Agent start / no start
-> blind retry / no retry
-> remaining durable Redmine state
```

Restart convergence is deliberately not executed here. The restart-time
`durable Redmine state x artifact state` decision remains Phase 50-6 ownership.

## Production boundaries under regression

- `AgentController`
  - releases the process-local issue lock when the downstream Agent Running
    mutation fails or becomes unconfirmed;
  - does not internally retry the failed operation.
- `Phase48_3ExactSourceResolvedHandler`
  - allocates `execution_id` before the Agent Running durable write;
  - invokes the Agent continuation only after exact durable confirmation.
- `RedmineAgentRunningWriter`
  - performs one complete Agent Running write and one exact read-back;
  - does not reinterpret write-time ambiguity as `eligibility_failed`.
- `Phase49SuccessfulFinalizationCoordinator`
  - reaches successful Redmine finalization only after the artifact is durable;
  - does not convert a success-finalization write failure into
    `artifact_persistence_failed`.
- `RedminePhase49ExecutionFinalizer`
  - performs one successful-finalization write and exact read-back.
- `RedmineStartedExecutionFailureFinalizer`
  - performs one started-failure write and exact read-back;
  - does not persist a local durable journal containing the observed failure
    classification.

## FI-01: Agent Running definite write failure

The regression injects FI-01 before the production Agent Running mutation can
be applied.

Assertions:

- one Agent Running write attempt is made;
- durable lifecycle remains `Ready for Agent`;
- execution fields remain absent in Redmine;
- no rejection rewrite is performed;
- the Agent continuation is not called;
- the local issue lock is released;
- the Controller operation fails to its caller.

The test then performs a separate, explicit later Controller evaluation. That
second evaluation allocates a different `execution_id`. This proves that a
later attempt is new execution preparation, not an automatic retry of a started
Agent.

## FI-02: Agent Running remote success + confirmation loss

The production Agent Running PUT succeeds and mutates the test backend. FI-02
is then injected into the exact read-back path.

Assertions:

- one write attempt is made;
- the caller sees an unconfirmed operation failure;
- the Agent continuation is not called;
- the local issue lock is released;
- independent backend observation shows durable lifecycle `Agent Running` and
  the allocated execution identity.

The test does not run restart reconciliation.

## FI-10: successful finalization ambiguity

A deterministic persistence fixture first records that the Phase 49 artifact is
durable.

### Definite finalization failure

FI-10 is injected before the Redmine finalization mutation is applied.

Expected durable result:

```text
Agent Running
+
durable artifact exists
```

The regression also asserts one Redmine write attempt and verifies that the
execution is not rewritten to `artifact_persistence_failed`.

### Remote success + confirmation loss

The finalization mutation is applied once, then FI-10 is injected into the
exact read-back path.

Independent backend observation must show:

```text
Ready for Independent Verification
changes_ready
expected artifact_reference
```

Only one finalization write is performed.

## FI-11: started-failure finalization ambiguity

### Definite finalization failure

For each canonical started failure (`agent_start_failed`, `agent_failed`, and
`timeout`), FI-11 is injected before the finalization mutation is applied.

The durable backend must remain:

```text
Agent Running
finished_at = absent
outcome = absent
artifact_reference = absent
```

The observed classification therefore remains non-durable. The existing
`STARTED_FAILURE_RECONCILIATION_FALLBACK` remains `interrupted`; Phase 50-5 does
not add a durable local classification store and does not execute restart
convergence.

### Remote success + confirmation loss

The started-failure finalization is applied once and FI-11 is injected into the
read-back path. Independent backend observation must show:

```text
Needs Human
agent_failed
finished_at present
artifact_reference absent
```

Again, there is exactly one write attempt and no blind retry.

## Boundary with Phase 50-6

This suite intentionally does **not** invoke startup reconciliation or artifact-
aware recovery. In particular, it does not attempt to reconstruct a non-durable
`agent_failed`, `timeout`, or `agent_start_failed` classification after a
definite FI-11 failure. Phase 50-6 owns the later convergence from durable
`Agent Running` plus artifact state.

## Existing guards

Phase 50-1 golden guards and the Phase 50-2 fault/consumer matrix continue to
run under the repository-wide unit suite. No production lifecycle or outcome
taxonomy is changed by this ticket.

## Verification

Run the complete environment verification:

```bash
npm run verify:phase50:environment
```

For local code-only iteration:

```bash
npm run lint &&
npm run typecheck &&
npm run test:unit
```
