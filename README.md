# ai-agent-runner

Dedicated Agent execution plane for the v0.4.0 system milestone.

This repository is intentionally separate from `mcp-mamono210/redmine`. The
Redmine MCP repository remains the approval/control plane and owns the canonical
cross-component contracts.

## Phase 48-1 scope

The runtime implements the Controller entry boundary required by Redmine issue
#5410:

```text
Controller startup
-> startup reconciliation entry point
-> idle poll
-> allowed project + Ready for Agent candidate
-> process-local duplicate-prevention lock
-> Issue re-fetch
-> Phase 46 approved handoff validation
-> exact approved Brief recovery from local read-only Phase 37 Git storage
-> existing Phase 36 / Phase 39 requirements-fingerprint revalidation
-> stale_requirements / eligibility_failed durable rejection
-> Phase 48-2 handoff
```

It deliberately does **not** implement credentialed source-repository access,
exact source revision resolution, formal Phase 47 authorization, `execution_id`,
`Agent Running`, sandbox creation, or Agent invocation. Those remain later Phase
48 responsibilities.

## Local-lock decision

For the v0.4.0 topology (`Controller=1`, `Worker=1`, `concurrency=1`) the
Controller uses a process-local in-memory lock. It is transient and is not a
durable execution Source of Truth. A process restart discards the lock; startup
reconciliation must use Redmine durable state.

## Redmine binding

Phase 48-1 has concrete Redmine adapters for:

- bounded `Ready for Agent` candidate polling;
- Issue re-fetch with journals / relations / children;
- exact-name approval metadata resolution;
- `Needs Human + stale_requirements|eligibility_failed` rejection writes;
- durable rejection read-back verification.

`AGENT_RUNNER_BRIEF_LIFECYCLE_FIELD_ID` is an environment-specific numeric
binding used only for the Redmine list filter. Canonical mappings are still
resolved from each target Issue by exact field name. Numeric IDs are not treated
as contract identities.

Read and write credentials are configured separately. Rejection diagnostics are
bounded to 2048 UTF-8 bytes and redacted before persistence. No pre-execution
rejection creates an `execution_id`.

## Approved Brief recovery

The handoff validator reuses the existing Phase 37 persistence configuration:

```text
AGENT_BRIEF_REPOSITORY_ROOT
AGENT_BRIEF_REPOSITORY
AGENT_BRIEF_CANONICAL_BRANCH
```

The repository root is a local read-only Git checkout or mirror. Validation uses
`git ls-tree <canonical-branch>` to establish the exact canonical Brief blob and
checks:

```text
persisted_revision
redmine_issue_id
repository
brief_revision
requirements_fingerprint
```

This is Brief-storage validation only. It does not perform the credentialed
application source access owned by Phase 48-2.

## Requirements fingerprint compatibility

`src/agent-brief/requirements-fingerprint-compat.ts` is a behavioral
compatibility binding to the canonical Phase 36 / Phase 39 implementation in
`mcp-mamono210/redmine`; it is not a second contract authority. Its source blob
IDs are recorded in the file and unit tests include the canonical Phase 39
SHA-256 vector so accidental drift fails visibly.

Use the same requirement custom-field allowlist as the Redmine MCP deployment:

```text
AGENT_BRIEF_REQUIREMENT_CUSTOM_FIELD_IDS
```

## Configuration

See `.env.example`. Minimum Phase 48-1 production wiring needs:

```text
AGENT_RUNNER_ALLOWED_PROJECTS
REDMINE_URL
REDMINE_API_KEY
REDMINE_WRITE_API_KEY
AGENT_RUNNER_BRIEF_LIFECYCLE_FIELD_ID
AGENT_BRIEF_REPOSITORY_ROOT
AGENT_BRIEF_REPOSITORY
```

The polling interval defaults to 30 seconds and the Redmine timeout defaults to
10 seconds.

`createPhase48_1ProductionController()` wires all Phase 48-1 responsibilities.
The caller still supplies:

- `StartupReconciler` — concrete recovery is owned by Phase 48-6;
- `EligibleCandidateHandler` — the continuation is owned by Phase 48-2 onward.

This keeps the #5410 boundary executable without silently pre-implementing later
Phase responsibilities.

## Validation

```bash
npm install
npm run lint
npm run typecheck
npm run test:unit
```
