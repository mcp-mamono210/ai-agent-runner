# Phase 50-2 Deterministic Harness / Environment Conformance

Issue: #5426

## Purpose

Phase 50-2 provides the shared verification substrate for Phase 50-3 through
Phase 50-7. It does not add test-only branches to production lifecycle logic.
Instead, consumers inject existing ports with deterministic fixtures and use one
shared fault/scenario registry.

The implementation fixes four boundaries:

```text
FI-01..FI-15
SC-01..SC-07
forward + reverse coverage matrix
S3 / sandbox conformance classification and coverage closure
```

## Entry gate

`docs/verification/phase50-entry-gate.json` records the Phase 50-2 entry snapshot:

```text
Phase 50-1 issue #5425 = closed
squash revision = aa60d3fb044a786fa35763f531d4d5db7b9a919d
open Phase 50 blocking defect = 0
expected-failure registry = existing Phase 50-1 registry
```

The unit gate re-runs the Phase 50-1 golden comparison and requires the existing
expected-failure registry to remain empty. A closed ticket without marker cleanup
is therefore insufficient.

## Deterministic harness

`src/verification/phase50-harness.ts` provides:

```text
Phase50FaultController
Phase50ScenarioController
Phase50RedmineFixture
Phase50DeterministicAgentFixture
Phase50SandboxFixture
Phase50InMemoryS3ObjectClient
Phase50DeterministicHarness
```

Faults are one-shot. The registry distinguishes:

```text
before
  definite failure before durable operation

after
  remote/durable operation succeeds, then caller loses confirmation

checkpoint
  Controller interruption between two durable stages
```

This is important for FI-01/FI-02 and FI-07/FI-08: the harness cannot collapse a
definite failure into the same durable state as remote-success/confirmation-loss.

The S3 fixture implements the production `Phase49S3ObjectClient` port, so Phase
49 persistence and recovery code can be exercised without a second artifact
format or persistence algorithm.

## Scenario controls

The scenario controller owns deterministic values for:

```text
SC-01 allowlist allow / deny / unknown / invalid
SC-02 Agent output bytes
SC-03 workspace disk bytes
SC-04 current Redmine requirements fingerprint
SC-05 current Brief revision
SC-06 moving branch HEAD
SC-07 artifact corruption mode
```

Phase 50-3 and Phase 50-6 share SC-04/05/06. The current/latest values are test
inputs; they must not become a replacement for started durable execution
identity.

## Coverage matrix

The machine-readable matrix is:

```text
docs/contracts/phase50-verification-matrix.json
```

It contains both directions:

```text
fault/scenario -> consumer ticket
required verification case -> control -> consumer ticket
```

Unit tests reject a missing FI/SC registry entry or a control with no reverse
coverage case.

## Success baseline and negative control

`tests/unit/phase50-harness.test.ts` executes both provisional success outcomes
through the canonical Phase 49 artifact persistence path:

```text
changes_ready -> durable artifact
no_changes    -> durable empty-patch artifact
```

Therefore:

```text
no_changes != artifact absent
```

The same test injects an artifact checksum mismatch and requires the canonical
verification path to fail. A failure for an unrelated reason is not counted as
the artifact negative control.

## S3 conformance

`src/verification/phase50-s3-conformance.ts` measures the selected S3-compatible
or real-S3 environment for:

```text
If-None-Match: *
existing-object conditional conflict
SHA-256 FULL_OBJECT
HeadObject ChecksumMode=ENABLED
GetObject ChecksumMode=ENABLED
ChecksumSHA256
lowercase metadata keys
exact logical metadata round-trip
SSE-S3 AES256
```

The probe uses a caller-supplied `Phase49S3ObjectClient`; the AWS integration
uses the existing `AwsSdkPhase49S3ObjectClient`. It does not add DeleteObject or
ListBucket to the production Controller requirement.

Use a dedicated bucket/prefix with lifecycle cleanup. The probe intentionally
leaves its verification object for the configured retention policy rather than
requiring Controller delete permission.

## Sandbox conformance

`src/verification/phase50-sandbox-conformance.ts` records the actual Docker
server implementation/version, OS/kernel, cgroup driver/version, security
options, nested-container/CI observations, configured internal network, and
managed proxy state.

It also *executes* enforcement checks instead of accepting configuration parsing
as proof:

```text
BoundedUtf8Capture -> measured truncation
TaskWorkspace      -> measured disk-limit rejection
SandboxResourcePolicy -> measured timeout AbortSignal
DockerSandboxRuntime -> production lifecycle timer through deterministic
                        DockerCommandRunner seam
```

The managed-network finding is only `compatible` after real Docker inspection and
traffic measurement prove all of the following:

```text
configured network is internal
network policy-digest label matches
managed proxy is running
managed-proxy role label matches
proxy policy-digest label matches
proxy is attached to the internal network
direct path from the internal client to the allowed origin is denied
allowed origin through the proxy returns HTTP 200
denied origin through the proxy returns HTTP 403
```

Missing environment access or missing traffic evidence is `unsupported` with an
unresolved Route C; it is not silently skipped.

CPU/memory are recorded as environment observations but are not invented as a
new canonical quota surface: the current `SandboxResourceLimits` contract does
not define CPU/memory fields. That difference is Route E / contract-neutral;
network, disk, output, timeout, and lifecycle semantics remain separate findings.

## Classification and coverage routes

The five classifications are:

```text
compatible
incompatible
unsupported
different-contract-affecting
different-contract-neutral
```

Coverage rules are enforced by `src/verification/phase50-conformance.ts`:

```text
incompatible / unsupported / different-contract-affecting
  -> Route A / B / C / D
  -> coverageExecuted=true
  -> non-empty coverage evidence

different-contract-neutral
  -> Route E only
  -> required contract assertions already pass
  -> evidence recorded
```

A planned route is not completion. `assertPhase50EnvironmentCoverageClosed()`
fails while any mandatory alternate coverage remains unexecuted.

## Reproducible local sandbox fixture

Phase 50-2 includes an isolated Docker fixture under `scripts/phase50/`. It does
not reuse or delete the documented production names `agent-runner-egress` /
`agent-runner-egress-proxy` by default. Instead it creates:

```text
phase50-conformance-egress          internal network
phase50-conformance-uplink          proxy/origin uplink network
phase50-conformance-egress-proxy    allowlist proxy, dual-homed
phase50-conformance-allowed-origin  allowed HTTP fixture
phase50-conformance-denied-origin   denied HTTP fixture
```

The setup script computes the exact Phase 47 network-policy digest using the
same category ordering as the runtime, applies the digest to the internal
network and proxy labels, and writes a temporary shell environment file. The
proxy permits only the deterministic allowed origin. The real conformance probe
then runs a client attached only to the internal network and verifies:

```text
direct -> allowed origin     blocked
proxy  -> allowed origin     HTTP 200
proxy  -> denied origin      HTTP 403
```

Manual setup / teardown:

```bash
npm run setup:phase50:sandbox
source "${TMPDIR:-/tmp}/ai-agent-runner-phase50-sandbox.env"
npm run test:integration:phase50
npm run teardown:phase50:sandbox
```

For the complete #5426 gate, keep the Phase 50 S3 variables in the current
shell and run:

```bash
npm run verify:phase50:environment
```

That command provisions the isolated sandbox fixture, runs lint / typecheck /
unit / Phase 50 integration / final environment conformance, and tears the
fixture down in a shell trap. Set `PHASE50_KEEP_SANDBOX_FIXTURE=1` only when the
Docker objects must remain for debugging.

## Commands

Normal deterministic verification:

```bash
npm run lint
npm run typecheck
npm run test:unit
```

S3 / sandbox integration probes:

```bash
npm run test:integration:phase50
```

The integration tests are environment-gated, but the final conformance command
is not a silent skip: it writes its record and then fails when unresolved
coverage remains.

`PHASE50_TESTED_GIT_REVISION` is optional. When omitted, the verifier records
the current repository revision from `git rev-parse HEAD`.

`PHASE50_ENVIRONMENT_CONFORMANCE_RECORD` is also optional. Its default is
`docs/verification/phase50-environment-conformance.json`; an explicit path may
be supplied when a dated evidence filename is required.

```bash
PHASE50_S3_CONFORMANCE_REGION=<region> \
PHASE50_S3_CONFORMANCE_BUCKET=<bucket> \
PHASE50_S3_CONFORMANCE_PREFIX=<dedicated base prefix> \
PHASE50_S3_CONFORMANCE_EXECUTION_ID=<lowercase UUIDv4> \
PHASE50_SANDBOX_POLICY_DIGEST=<resolved policy digest> \
npm run verify:phase50:conformance
```

Optional overrides:

```text
PHASE50_TESTED_GIT_REVISION
PHASE50_ENVIRONMENT_CONFORMANCE_RECORD
```

Each S3 conformance invocation automatically allocates a unique `runs/<uuid>/`
sub-prefix below `PHASE50_S3_CONFORMANCE_PREFIX`. This keeps the object address
deterministic within one probe while allowing integration and final conformance
commands to reuse the same configured execution ID without colliding with a
previous immutable `If-None-Match: *` test object. Test objects are not deleted by
the Controller credential; bucket lifecycle retention owns cleanup.

For an S3-compatible service add:

```text
PHASE50_S3_CONFORMANCE_ENDPOINT
```

and the verifier uses path-style requests. For AWS S3 leave the endpoint unset.

The sandbox probe reads the existing deployment values:

```text
AGENT_RUNNER_SANDBOX_NETWORK_NAME
AGENT_RUNNER_SANDBOX_PROXY_CONTAINER
```

The generated record must be committed only after all mandatory findings pass
or have executed alternate coverage. This keeps "route selected" distinct from
"coverage completed".
