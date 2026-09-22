# ai-agent-runner

Dedicated Agent execution plane for the v0.4.0 system milestone.

This repository is intentionally separate from `mcp-mamono210/redmine`. The
Redmine MCP repository remains the approval/control plane and owns the canonical
cross-component contracts.

## Current Phase 50 completion / Phase 51 RC boundary

Phase 50 verification is complete. The current v0.4.0 system-milestone
functional boundary implemented by Agent Runner is:

```text
Ready for Agent
-> safe one-shot Agent execution
-> durable immutable artifact
-> Ready for Independent Verification
```

The component package version remains an independent Agent Runner identity; the
system milestone number is not a component-version selection rule. Phase 51 RC
evidence is canonical in `mcp-mamono210/redmine`; this README only describes the
component boundary and points to repository-local verification support.

Current v0.4.0 out of scope remains:

```text
Git remote push
CircleCI / CI feedback loop
Agent correction loop
automatic Agent retry
Pull Request automation
automatic merge
deployment automation
multiple Workers / Runner instances
distributed execution
```

Phase 50 release-quality and environment verification remain defined by the
repository's existing Phase 50 verification surfaces. Phase 51 verification-only
probes live under `scripts/phase51/` and do not become a second runtime or
compatibility Source of Truth.

## Phase 48-1 historical implementation slice

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

At Phase 48-1 this slice deliberately did **not** implement credentialed
source-repository access, exact source revision resolution, formal Phase 47
authorization, `execution_id`, `Agent Running`, sandbox creation, or Agent
invocation. Those responsibilities are implemented by the later Phase 48
sections documented below.

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

## Phase 48-2 repository access / exact source

Phase 48-2 adds the Controller-side repository boundary after Phase 48-1 has
validated the approved handoff and revalidated requirements:

```text
Phase 46 repository identity
-> early repository allowlist pre-check
-> Controller reads repository credential
-> credentialed source-ref resolution
-> exact immutable Git commit
-> Phase 48-3 formal-gate continuation
```

The runtime repository identity is never normalized. `AGENT_RUNNER_REPOSITORY_CONFIG`
contains the deployment-side allowlist and repository-access mapping. Each entry
uses:

```text
repository|remote_url|source_ref|username_env|password_env
```

Multiple entries are separated by `;`. Only configured repository entries have
leading/trailing ASCII whitespace removed; authorization then uses exact string
equality. Missing/invalid/duplicate configuration fails closed. An explicitly
empty value is a valid allowlist that authorizes no repository.

Credentials remain Controller-owned. The implementation reads the configured
credential environment variables only after authorization succeeds. Git receives
the credential in its child-process environment through an HTTP authorization
header; the secret is not placed in command arguments, result values, Redmine
execution fields, or Agent input.

Exact source resolution uses the configured moving `source_ref` only to obtain
one full immutable Git commit ID. The downstream continuation receives:

```text
repository
source_revision
```

No `execution_id` is allocated in Phase 48-2. Authorization/configuration,
credential, or exact-source failures are routed through the existing
`Needs Human + eligibility_failed` pre-execution rejection writer.

### Checkout boundary

The repository component also exposes the Phase 48-2 checkout interface:

```text
checkout(repository, source_revision, target_dir)
```

`target_dir` must already exist, be absolute and empty, and remains caller-owned.
The component fetches only the already-fixed exact `source_revision`; it does not
re-resolve `source_ref`, branch, tag, `HEAD`, or latest state during checkout.
Phase 48-4 owns creation and cleanup of the task-scoped workspace passed here.

## Phase 48-3 execution preparation / durable start

Phase 48-3 consumes the exact `repository + source_revision` fixed by Phase 48-2
and preserves the Phase 46 / Phase 47 ordering:

```text
exact source fixed
-> formal Phase 47 authorization gate
-> execution preparation entered
-> lowercase UUIDv4 execution_id allocated
-> immutable execution-input snapshot
-> logical execution record prepared
-> one durable Redmine Agent Running mutation
-> exact read-back confirmation
-> Phase 48-4 continuation
```

The formal gate re-establishes authorization against the same repository policy.
It consumes the unchanged Phase 46 repository identity plus the already-fixed
full Git object ID and does not re-resolve a branch, tag, `HEAD`, or another
moving ref. Gate failure remains an execution-ID-less
`Needs Human + eligibility_failed` rejection.

After the formal gate succeeds, `execution_id` is allocated as a canonical
lowercase UUIDv4. The immutable snapshot fixes:

```text
execution_id
issue_id
repository
source_revision
brief_revision
persisted_revision
requirements_fingerprint
approved Brief reference
```

The corresponding logical execution record represents `finished_at`, `outcome`,
and `artifact_reference` as pending values until later phases establish them.
Mutable Redmine or Git state is not used to retarget this started identity.

Before the Phase 48-4 continuation is invoked, the Controller performs one
Redmine start mutation containing `Agent Running`, the execution identity and
all required start facts. The same mutation clears stale pre-execution rejection
projection fields and writes the physically permitted empty pending values for
`finished_at`, execution `outcome`, and `artifact_reference`.

HTTP success alone is not permission to continue. The Controller re-fetches the
Issue and requires every execution/rejection field in the expected current
projection to match exactly. A failed, rejected, partial, ambiguous,
mismatching, or unverifiable mutation stops before the downstream continuation;
it is not converted back into an execution-ID-less pre-execution rejection.
Phase 48-6 owns recovery of such started/prepared ambiguity.

## Phase 48-4 task workspace / Docker sandbox

Phase 48-4 makes the remaining deployment-level implementation choices required
by #5413 without changing the Phase 47 canonical security contract:

```text
sandbox/container runtime = Docker Engine
Agent provider             = Codex CLI
execution isolation        = 1 execution attempt / 1 fresh container
```

The provider-specific Codex invocation remains Phase 48-5. Phase 48-4 only
creates the task workspace, exact-source checkout target, sandbox boundary,
network/resource controls, mechanical inspection, and disposal interface.

The post-`Agent Running` path is:

```text
Agent Running durable read-back confirmed
-> fresh task-scoped host workspace
-> Phase 48-2 checkout(repository, source_revision, target_dir)
-> workspace disk-bound check
-> managed network policy verification
-> fresh Docker sandbox create
-> mechanical mount / privilege / credential inspection
-> Phase 48-5 continuation
-> dispose container + workspace
```

The source checkout remains Controller-side. The Agent receives the prepared
workspace and does not receive the Controller repository credential, Redmine
Writer credential, control-plane credential, host credential store, or Docker
socket.

### Filesystem and mount isolation

The Docker sandbox is created with a read-only root filesystem, all Linux
capabilities dropped, and `no-new-privileges`. The only host-backed mount allowed
by the mechanical verifier is exactly:

```text
<one execution-scoped workspace> -> /workspace (rw)
```

Any second bind/volume mount, workspace mismatch, privileged container, missing
capability drop, missing no-new-privileges, Docker socket mount, or known
Controller credential environment causes preparation to fail closed. Ephemeral
`/tmp` is container-local tmpfs and is separately bounded.

### Network enforcement

The sandbox is not attached to Docker's default `bridge`, `host`, or an open
public network. It attaches only to a dedicated **internal** Docker network.
External access must go through a managed egress proxy on that internal network.
The resolved policy covers exactly the five Phase 47 categories:

```text
agent-provider
package-registry
required-runtime-dependency
source-repository
other-external-endpoint
```

For the current v0.4 Codex mode, `agent-provider` must resolve to a bounded
required endpoint set, `source-repository` is denied inside the Agent sandbox,
and `other-external-endpoint` is denied. Package registry and runtime dependency
access must also be explicitly resolved; missing/unresolved/wildcard policy is
not permission for open egress.

The runtime computes a deterministic `sha256:` digest of the resolved category
policy. Before sandbox creation it requires the Docker internal network and the
managed proxy container to advertise the same digest via:

```text
io.mcp.agent-runner.egress-policy-sha256=<digest>
```

The proxy container must additionally advertise:

```text
io.mcp.agent-runner.egress-proxy=true
```

and be running on the configured internal network. This binds the Runner's
resolved policy to the deployment-managed proxy/firewall configuration instead
of silently falling back to unrestricted Docker egress.

### Resource boundary

Phase 48-4 requires finite configured values for:

```text
execution timeout
output capture bytes
diagnostic capture bytes
workspace disk bytes
container lifecycle milliseconds
workspace disk-check interval
tmpfs bytes
```

No invalid or missing limit becomes an unbounded default. `BoundedUtf8Capture`
keeps output/diagnostic capture finite and records truncation. The workspace is
checked before sandbox creation and monitored while the sandbox exists. The
container has a lifecycle timer; disk/lifecycle enforcement aborts the sandbox
signal and force-removes the container. Phase 48-5 consumes the execution-time
signal/capture limits for the one-shot Agent invocation, while Phase 48-6 owns
startup orphan reconciliation after process/host interruption.

### Disposal / Phase 48-5 handoff

`Phase48_4AgentRunningConfirmedHandler` owns transient workspace/sandbox lifetime
around the Phase 48-5 continuation. The downstream handler returns one of the
explicit disposal classes (`success`, `failure`, `timeout`, `interruption`, etc.),
and container/workspace cleanup runs in `finally`.

If checkout or sandbox preparation fails after `Agent Running` has already been
durably established, Phase 48-4 does **not** rewrite the event as a pre-execution
rejection. It invokes the Phase 48-5 preparation-failure hook, allowing the later
started-execution finalizer to map that failure under the existing Phase 45
outcome taxonomy while Phase 48-4 still cleans transient resources.

The pinned Phase 48-4 sandbox image must contain the Codex CLI runtime and a
`sleep` executable. Phase 48-4 overrides the container entrypoint to `sleep
infinity` so the sandbox can be created/inspected first; Phase 48-5 owns starting
the container and invoking Codex through the provider-specific Agent Adapter.

## Phase 48-5 Agent Adapter / one-shot execution / started failure finalization

Phase 48-5 consumes the Phase 48-4 prepared sandbox only after `Agent Running`
has been durably confirmed. The provider-specific boundary is isolated behind
`AgentAdapter`; the v0.4 implementation is `CodexCliAgentAdapter`.

The production one-shot invocation is intentionally a single non-interactive
Codex call:

```text
Docker sandbox start
-> prepare ephemeral CODEX_HOME under container /tmp
-> docker exec -i ... codex --ask-for-approval never exec
     --ephemeral
     --ignore-user-config
     --sandbox workspace-write
     -
-> exactly one result classification
```

The prompt points Codex at the exact approved Brief path derived from the
immutable execution input:

```text
docs/agent-briefs/<issue_id>/revisions/<brief_revision>.md
```

There is no automatic Agent retry and no `codex exec resume`. The provider API
credential is supplied only to that `docker exec` process. The credential value
is not embedded in argv; Docker receives only the environment-variable name.
Codex is also forced to enable key/token/secret default exclusions for shell
children, preventing the provider key from being inherited by repository build
or test commands.

Agent stdout and diagnostic stderr are captured through the finite Phase 48-4
byte limits. Before either representation can cross the Agent Adapter boundary,
the reusable `KnownSecretRedactor` processes configured known secrets and common
credential syntax. A redaction failure produces no raw successful result.
Phase 48-6 reuses the same redaction abstraction rather than defining another
secret-filtering implementation.

The one-shot result taxonomy inside Phase 48 is:

```text
exit 0 + working tree changed -> changes_ready (provisional)
exit 0 + working tree clean   -> no_changes (provisional)
execution timeout             -> timeout
provider/process start fail   -> agent_start_failed
other nonzero/provider fail   -> agent_failed
```

`changes_ready` and `no_changes` are deliberately not successful durable
finalization in Phase 48. They are passed to the injected
`ProvisionalAgentResultHandler` for the later Phase 49 artifact boundary. Phase
48 does not write `Ready for Independent Verification` and does not populate an
artifact reference for those results.

Started failures use `RedmineStartedExecutionFailureFinalizer`. Before the
single write attempt, it re-fetches the Issue and verifies that the durable
`Agent Running` projection still belongs to the exact execution identity. It
then writes only:

```text
Agent Execution Lifecycle = Needs Human
Agent Execution Finished At = RFC3339 timestamp
Agent Execution Outcome = timeout | agent_start_failed | agent_failed
Agent Artifact Reference = empty
```

The execution ID, Brief identity, requirements fingerprint, repository, exact
source revision, and started timestamp are preserved. A 2xx write is not enough:
the finalizer re-fetches the Issue and confirms the exact current projection.
There is no blind finalization retry.

If the finalization write fails, is partial, ambiguous, or cannot be verified,
the handler does not claim success. Cleanup still runs through the Phase 48-4
`finally` boundary and the durable Redmine projection may remain `Agent Running`.
Phase 48-6 startup reconciliation owns the later canonical fallback to
`interrupted`; the observed timeout/Agent failure is not treated as authoritative
when its finalization could not be confirmed.

Checkout or sandbox preparation failure after `Agent Running` but before provider
invocation is routed through the same finalizer as `agent_start_failed`. This
keeps execution-ID-less pre-execution rejection semantics separate from failures
of an already-started durable attempt.

## Phase 48-6 startup reconciliation and cleanup

Phase 48-6 provides the concrete restart/recovery boundary for executions that
remain durably `Agent Running`. The Controller still runs startup reconciliation
before the first poll. Recovery does not resume or retry the Agent invocation.

The startup sequence is:

```text
Controller startup
  -> remove Agent Runner-owned orphan sandbox containers
  -> remove Agent Runner-owned attempt workspaces
  -> query allowed Redmine projects for Agent Execution Lifecycle = Agent Running
  -> re-fetch each durable execution
  -> preserve the existing execution identity
  -> write Needs Human + interrupted + finished_at + empty artifact_reference
  -> exact read-back confirmation
  -> polling
```

`AGENT_RUNNER_EXECUTION_LIFECYCLE_FIELD_ID` identifies the environment-specific
Redmine custom-field ID used only for the bounded `Agent Running` startup query.
The finalizer still binds the execution fields by exact canonical field name and
verifies the current durable identity before writing.

The v0.4.0 lock remains process-local/in-memory. A process restart therefore
removes stale local lock state by construction; Redmine, not the lock, is the
recovery Source of Truth.

Orphan cleanup is ownership-bounded. Docker cleanup selects only containers with
`io.mcp.agent-runner.sandbox=true`, and workspace cleanup removes only canonical
`attempt-<uuidv4>-<suffix>` directories below the configured workspace root.
The managed egress proxy and unrelated filesystem entries are not cleanup
targets.

If orphan cleanup or interrupted finalization cannot be confirmed, startup
reconciliation fails closed and polling does not begin. There is no blind Agent
retry and no blind Redmine write retry. A later Controller startup may retry the
state reconciliation while Redmine still says `Agent Running`.

Recovery diagnostics cross the same reusable Phase 48-5 redaction component
before any injected diagnostic sink sees them. If redaction itself fails, raw
content is suppressed. Phase 48-6 does not add S3/artifact inspection; Phase 49
owns durable artifact persistence and later artifact-aware reconciliation.

## Phase 48-7 development Walking Skeleton

Phase 48-7 adds a development-only verification surface over the existing Phase
48-1 through Phase 48-6 runtime. It does not add a second execution lifecycle or
production success transition.

`createPhase48_7DevelopmentRuntime()` wires the Phase 48-6 production runtime to
a provisional-success handler that captures, before workspace disposal:

- immutable execution identity;
- provisional `changes_ready` / `no_changes` outcome;
- changed-file information;
- a bounded local Git patch / change-set snapshot; and
- a bounded execution summary for the Phase 49 handoff.

The local patch remains transient development state. It is not the production
durable artifact Source of Truth. Phase 49 still owns manifest creation, patch
serialization, checksum, private S3 persistence, `artifact_reference`, successful
Redmine finalization, and `Ready for Independent Verification`.

The development Walking Skeleton also requires an explicit `DevelopmentFixtureReset`
port. The reset implementation belongs to the development test harness or
fixture system and is intentionally not part of the production Agent Controller
lifecycle. If a successful provisional execution is not reset and the Controller
restarts while Redmine remains `Agent Running`, Phase 48-6 reconciliation is
expected to finalize it as `interrupted` / `Needs Human`.

Development capture bounds are configurable with:

```text
AGENT_RUNNER_DEVELOPMENT_PATCH_CAPTURE_BYTES
AGENT_RUNNER_DEVELOPMENT_SUMMARY_CAPTURE_BYTES
```

See `docs/phase48-final-verification.md` for the final Phase 48 verification and
Phase 49 handoff boundary.
