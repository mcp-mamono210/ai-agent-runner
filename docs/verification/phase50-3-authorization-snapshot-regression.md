# Phase 50-3 Authorization / Snapshot Immutability Regression

Issue: #5427

This verification suite consumes the Phase 50-2 deterministic controls owned by
#5426 and exercises the existing production boundaries rather than introducing a
second authorization or execution-identity implementation.

## Production boundaries under regression

- `GitCliRepositoryComponent`
  - `RepositoryAccessPolicy.authorize()` runs before credential lookup.
  - denied / unknown / invalid repository authorization therefore cannot reach
    credentialed Git access or source resolution.
- `Phase48_2EligibleCandidateHandler`
  - repository authorization/source-resolution failures map to
    `eligibility_failed`.
- `Phase47FormalAuthorizationGate`
  - consumes repository plus the already-fixed full source revision and does not
    resolve a moving ref or obtain credentials.
- `Phase48_3ExactSourceResolvedHandler`
  - formal gate precedes `execution_id` allocation.
  - the started execution snapshot is frozen and fixes repository,
    source_revision, Brief identity, persisted revision, and requirements
    fingerprint.
- `Phase49ProvisionalResultHandler`
  - artifact handoff identity is copied only from `PreparedExecution.input`.
- `AgentController` + `InMemoryIssueLock`
  - duplicate prevention is process-local and transient.

## Phase 50 controls consumed

| Control | Regression |
| --- | --- |
| SC-01 | early allowlist allow / deny / unknown / invalid; formal allow / deny / unknown |
| FI-14 | formal authorization invocation failure before execution_id allocation |
| SC-04 | mutable Redmine requirements after start do not replace started requirements identity |
| SC-05 | current Brief revision change after start does not replace started Brief identity |
| SC-06 | moving branch HEAD after start does not replace fixed source revision |

## Fail-closed assertions

For early and formal authorization failures the regression verifies:

- lifecycle becomes `Needs Human` through the production rejection writer;
- rejection outcome is `eligibility_failed`;
- `Agent Execution ID` remains empty;
- no Agent-running persistence or downstream Agent continuation occurs;
- early authorization failures do not consult credentials or invoke Git.

## Snapshot / artifact assertions

After a successful start, SC-04 / SC-05 / SC-06 mutate the Phase 50 fixture's
current Redmine requirements, Brief revision, and branch HEAD. The regression
then sends the already-started execution into the production Phase 49
provisional handler and asserts that:

- source resolution occurred exactly once;
- started `source_revision` remains fixed;
- started Brief revision / persisted revision remain fixed;
- started requirements fingerprint remains fixed;
- artifact handoff identity exactly matches the started immutable execution
  input rather than current mutable state.

## Duplicate-prevention boundary

The regression holds one controller invocation inside the eligible candidate
handler and verifies that a second local poll cannot enter the same Issue while
the process-local lock is held. After release, a later poll can proceed. A new
`InMemoryIssueLock` starts empty, demonstrating that the lock is not a durable
Source of Truth.

Restart/recovery behavior is deliberately not implemented or duplicated here.
It remains owned by Phase 50-6.

## Verification

Run the repository-wide gates:

```bash
npm run lint &&
npm run typecheck &&
npm run test:unit &&
npm run test:integration:phase50
```

The existing Phase 50-1 golden guards remain part of `test:unit`.
