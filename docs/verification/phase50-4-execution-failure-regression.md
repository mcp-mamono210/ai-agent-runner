# Phase 50-4 Execution Failure Outcome Regression

Issue: #5428

This regression fixes the initial-execution failure mapping established by
Phases 46-49. It consumes the Phase 50-2 deterministic fault controls and runs
through existing production boundaries rather than introducing a second failure
classification implementation.

## Scope

Phase 50-4 owns only the initial execution path:

- pre-execution stale-requirements rejection;
- Agent start failure;
- Agent execution failure;
- deterministic execution timeout;
- definite artifact persistence failure.

The following remain outside this ticket:

- Redmine write ambiguity: Phase 50-5;
- restart and artifact-aware reconciliation: Phase 50-6;
- ambiguous PutObject recovery: Phase 50-6.

## Production boundaries under regression

- `AgentController`
  - a requirements fingerprint mismatch remains a pre-execution rejection;
  - no execution identity or Agent invocation is created for `stale_requirements`.
- `RedminePreExecutionRejectionWriter`
  - persists `Needs Human + stale_requirements` through the rejection fields.
- `CodexCliAgentAdapter`
  - start failure maps to `agent_start_failed`;
  - non-zero execution failure maps to `agent_failed`;
  - execution timeout maps to `timeout`.
- `Phase48_5SandboxPreparedHandler`
  - started failures are finalized rather than sent to provisional success.
- `RedmineStartedExecutionFailureFinalizer`
  - preserves the immutable started execution identity;
  - writes `Needs Human`, `finished_at`, exact failure outcome, and empty artifact reference;
  - performs no automatic Agent retry.
- `Phase48_4AgentRunningConfirmedHandler`
  - timeout disposal is propagated to the sandbox;
  - sandbox disposal also removes the task workspace through the existing handle contract.
- `Phase49SuccessfulFinalizationCoordinator`
  - a definite persistence failure is converted to the canonical
    `storage_failure` reason at the finalization port;
  - success finalization is unreachable after the failed persistence operation.
- `RedminePhase49ExecutionFinalizer`
  - persists `Needs Human + artifact_persistence_failed` with an empty artifact reference.

## Deterministic controls consumed

| Control | Regression |
| --- | --- |
| FI-03 | provider/container start failure -> `agent_start_failed` |
| FI-04 | Agent execution failure -> `agent_failed` |
| FI-05 | deterministic execution timeout -> `timeout` + cleanup |
| FI-07 | definite PutObject failure -> `artifact_persistence_failed` |

FI-08 is deliberately not used because ambiguous PutObject recovery belongs to
Phase 50-6.

## Started / non-started boundary

`stale_requirements` is asserted before execution start:

- lifecycle becomes `Needs Human`;
- rejection outcome is `stale_requirements`;
- rejection diagnostic contains the deterministic stale reason;
- `Agent Execution ID` remains empty;
- `Agent Execution Outcome` remains empty;
- artifact reference remains empty;
- downstream Agent handling is not invoked.

FI-03 / FI-04 / FI-05 are asserted after a complete `Agent Running` identity is
already present. The regression verifies that the execution ID and exact source
revision are preserved while the durable lifecycle becomes `Needs Human` with
the exact started failure outcome.

## Timeout cleanup

The timeout case passes through the production Phase 48-4 orchestration. The
regression asserts:

- the Agent runner is invoked exactly once;
- durable outcome is `timeout`;
- sandbox disposal reason is `timeout`;
- the task workspace no longer exists after disposal.

This tests the cleanup result rather than merely checking the existence of a
timeout configuration value.

## Definite artifact persistence failure

FI-07 is injected into the Phase 50 in-memory S3 object client and consumed by
the production Phase 49 persistence/finalization coordinator. The regression
asserts:

- FI-07 is observed;
- no object remains at the deterministic execution-ID address;
- finalization receives reason `storage_failure`;
- durable lifecycle is `Needs Human`;
- durable outcome is `artifact_persistence_failed`;
- artifact reference is empty;
- `Ready for Independent Verification` is never reached.

## Scope and taxonomy guards

The suite also reads the canonical Phase 50 baseline and verification matrix to
assert that:

- the nine execution outcomes are unchanged;
- FI-03 / FI-04 / FI-05 / FI-07 remain owned by Phase 50-4;
- FI-10 / FI-11 remain owned by Phase 50-5;
- restart/reconciliation fault seams remain owned by Phase 50-6 (and Phase 50-7
  where the existing matrix requires it).

The existing Phase 50-1 golden guards continue to run as part of `test:unit`.

## Verification

Run the complete environment verification so the existing S3 and sandbox
conformance checks remain non-skipped:

```bash
npm run verify:phase50:environment
```

For local code-only iteration, the ordinary repository gates remain:

```bash
npm run lint &&
npm run typecheck &&
npm run test:unit
```
