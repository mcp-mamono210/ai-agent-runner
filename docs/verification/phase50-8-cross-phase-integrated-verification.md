# Phase 50-8 Cross-phase Integrated Verification / Real Infrastructure Policy / Phase 51 Handoff

Issue: #5432

Phase 50-8 is the final Phase 50 gate. It does not duplicate the detailed
Phase 50-3 through Phase 50-7 fault/scenario matrices. It verifies that the
shared deterministic harness, golden contracts, environment conformance, and
state-reset boundaries continue to compose correctly across those verification
surfaces.

## Entry facts

As observed on 2026-09-21, Redmine records the Phase 50 prerequisite children as
closed at 100%:

```text
#5425 Phase 50-1 closed
#5426 Phase 50-2 closed
#5427 Phase 50-3 closed
#5428 Phase 50-4 closed
#5429 Phase 50-5 closed
#5430 Phase 50-6 closed
#5431 Phase 50-7 closed
```

The Phase 50 parent currently has no additional blocking-defect child issue.
`docs/verification/phase50-expected-failures.json` contains zero entries.

These facts are prerequisites, not substitutes for executing the Phase 50-8 gate
on the final tested Git revision.

## Shared fixture boundary

The cross-phase integration test reuses production-facing Phase 50 test seams:

```text
Phase50DeterministicHarness
InMemoryIssueLock
Phase49S3ArtifactPersistence
filesystem-backed disposable workspace fixture
```

It keeps one harness process alive across all scenario runs. The test does not
create a second lifecycle authority, artifact format, execution identity, or
fault/scenario matrix.

The canonical scenario set intentionally touches different Phase 50 concerns:

```text
authorization-snapshot
successful-artifact
fault-rejection
resource-boundary
```

The individual Phase 50-3 through Phase 50-7 suites remain authoritative for the
complete FI-01..FI-15 / SC-01..SC-07 behavioral matrix.

## Ordering / repeatability proof

The same fixture family executes three passes:

```text
Run A: canonical order
Run B: reverse order
Run C: canonical order again in the same harness process
```

Scenario observations are normalized by scenario identity. Run B and Run C must
match Run A exactly.

This proves that a preceding scenario cannot change the expected result of a
later scenario merely through test execution order.

## Reset / residue contract

After every scenario the integration test resets the shared fixture and asserts:

```text
Redmine lifecycle      = Ready for Agent
Redmine outcome        = empty
requirements fingerprint = deterministic baseline
Brief revision         = initial revision
Git branch head        = deterministic baseline
S3 deterministic key   = absent
workspace              = empty
local issue lock       = released
fault observations     = empty
scenario controls      = empty
sandbox network state  = not applied
```

The successful-artifact scenario intentionally leaves an S3 object, workspace
content, and local lock held before reset so the subsequent clean assertion is a
real residue check rather than a no-op assertion.

Production concurrency remains one Controller / one Worker / one execution. A
parallel test mode is not introduced by this ticket.

## Final expected-failure gate

`tests/unit/phase50-final-gate.test.ts` requires:

```text
Phase 50 golden contract == current implementation projection
expected-failure registry count = 0
XPASS = suite failure
permanent describe.skip / it.skip / test.skip = 0
permanent todo / xfail test marker = 0
```

Conditional environment execution remains allowed where the Phase 50 environment
runner enables the required integration fixture. Mandatory semantics still have
to be coverage-closed by the conformance record.

## Environment closure

The final gate parses:

```text
docs/verification/phase50-environment-conformance.json
```

and requires all persisted findings to satisfy the Phase 50 conformance rules.
Both `s3` and `sandbox` surfaces must be present.

The current record contains no finding that is both non-compatible and missing
executed alternate coverage. Contract-neutral differences retain route E evidence;
contract-affecting differences require executed route A-D evidence.

For the final tested revision, rerun:

```bash
npm run verify:phase50:environment
```

The command rewrites the conformance record with the tested Git revision and fails
if required S3 or sandbox semantics are unsupported without executed coverage.

## Contract alignment / child numbering

Redmine `040_ロードマップ` version 5 and the Phase 50 parent describe the same
8-child structure:

```text
50-1 Machine-verifiable Contract Baseline / Golden Guard
50-2 Deterministic Harness / Fault Injection / Environment Conformance
50-3 Authorization / Snapshot Immutability Regression
50-4 Execution Failure Outcome Regression
50-5 Redmine Durable-write / Finalization Ambiguity Regression
50-6 Crash / Artifact-aware Reconciliation / Same-run Artifact Conflict Regression
50-7 Artifact Restore / Security / Secret / Resource Regression
50-8 Cross-phase Integrated Verification / Real Infrastructure Policy / Phase 51 Handoff
```

Repository documentation that mentions Phase 50-6 or Phase 50-7 for their actual
owned behavior remains valid. Search results were reviewed for stale child-count
wording; no old six-child or seven-child Phase 50 structure was retained as the
current structure.

The artifact handoff contract is updated by #5432 so the previously open restore
and real-infrastructure decisions are no longer presented as unresolved.

## Real infrastructure continuation policy

The machine-readable decision is:

```text
docs/verification/phase50-real-infrastructure-policy.json
```

### Real private S3

Selected option:

```text
A. mandatory per system release
```

Release evidence command:

```bash
npm run verify:phase49:s3
```

Reason: conditional PutObject behavior, FULL_OBJECT checksum, metadata projection,
IAM policy, encryption, and bucket lifecycle can drift independently of the
normal deterministic suite. Change-triggered or scheduled verification may be
additional evidence but is not a substitute for the release gate.

### Sandbox / production-equivalent environment

Selected policy:

```text
npm run verify:phase50:environment
= mandatory per system release
```

There is no unresolved production-equivalent contract gap in the current
conformance record. A separate always-on second sandbox suite is therefore not
introduced. If a future record exposes a contract-affecting gap, release PASS is
blocked until an A-D alternate coverage route has actually executed and its
evidence is persisted.

## Verification commands

Code-level iteration:

```bash
npm run lint &&
npm run typecheck &&
npm run test:unit &&
npm run test:integration:phase50
```

Final environment gate:

```bash
npm run verify:phase50:environment
```

System-release real-S3 gate:

```bash
npm run verify:phase49:s3
```

The final PASS record must be produced only after these commands succeed against
the final committed revision. The pre-#5432 implementation base revision is:

```text
85ebac9cb9c16461036881716d5166537a31fdfd
```

That revision is provenance for the implementation input, not the final tested
revision after applying this ticket.

## Final verification record requirements

Before closing #5432, persist a final verification record that identifies:

```text
verification date
tested Git revision
Phase 50 child status
canonical-order result
alternate-order result
repeat-run result
golden contract result
open blocking defect count
expected-failure count
S3 conformance summary
sandbox conformance summary
alternate coverage result
real S3 continuation policy
sandbox real-environment policy
known limitations
out-of-scope boundary
```

The record must not claim PASS for a revision that does not contain the Phase
50-8 integration/final-gate files.

## Phase 51 handoff

Phase 51 release preparation consumes:

```text
final tested Git revision
Phase 45-49 canonical contract revisions
Phase 50 golden contract
Phase 50 fault/scenario verification matrix
Phase 50 environment-conformance record
Phase 50 final verification record
real infrastructure continuation policy
verification commands and environment assumptions
remaining release-only checks
known limitations
```

Phase 51 is release preparation / cross-component compatibility verification. It
does not redesign the execution or artifact architecture proven by Phase 50.

## Out of scope

Phase 50-8 does not introduce:

```text
Git push
CircleCI feedback loop
CI failure feedback to Agent
Agent correction loop
automatic Agent retry
Pull Request automation
automatic merge
deployment automation
multiple Workers
multiple Runner instances
distributed claim / lease / heartbeat / queue
```
