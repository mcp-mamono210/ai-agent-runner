# Phase 50 Final Verification / Phase 51 Handoff

This document is the release-facing close procedure for Redmine issue #5432.
Phase 50-1 through Phase 50-8 form one verification structure; this document does
not create a ninth implementation responsibility.

## 1. Verification input boundary

The final gate consumes, without redefining:

```text
Phase 45 architecture / lifecycle / Source of Truth contract
Phase 46 execution handoff / immutable input contract
Phase 47 authorization / sandbox / security contract
Phase 48 one-shot execution implementation and recovery boundary
Phase 49 durable artifact contract and real-S3 verifier
Phase 50-1 golden contract
Phase 50-2 deterministic harness / FI-SC matrix / conformance contract
Phase 50-3..50-7 regression suites
```

The implementation base used to prepare #5432 is:

```text
85ebac9cb9c16461036881716d5166537a31fdfd
```

Do not use that SHA as the final verification SHA after the #5432 files have been
applied. Final evidence must identify the committed revision that actually
contains Phase 50-8.

## 2. Deterministic cross-phase gate

`tests/integration/phase50-cross-phase-integrated-verification.test.ts` executes a
single shared harness process in canonical, reverse, and repeat order. The test
requires equal normalized observations and explicit cleanup of Redmine fixture,
Brief fixture, Git fixture, S3 key, workspace, local lock, fault controller,
scenario controller, and sandbox network state.

The full individual FI/SC behavior remains owned by the Phase 50-3 through
Phase 50-7 tests. The final gate checks composition and isolation rather than
copying those matrices.

## 3. Golden / expected-failure gate

`tests/unit/phase50-final-gate.test.ts` requires:

```text
golden contract match
expected-failure entries = 0
XPASS = failure
permanent skip/todo/xfail marker = 0
S3 + sandbox conformance surfaces present
all persisted conformance differences coverage-closed
```

## 4. Real infrastructure policy

Canonical policy:

```text
docs/verification/phase50-real-infrastructure-policy.json
```

Real private S3 is mandatory per system release:

```bash
npm run verify:phase49:s3
```

Sandbox/S3 environment conformance is mandatory per system release:

```bash
npm run verify:phase50:environment
```

The environment command is fail-closed for unsupported or contract-affecting
semantics without executed alternate coverage. A future production-equivalent
sandbox gap therefore cannot silently become PASS.

## 5. Final command sequence

Run on the final committed revision:

```bash
npm run lint &&
npm run typecheck &&
npm run test:unit &&
npm run test:integration:phase50
```

Then run the environment gate with the required Phase 50 S3 and sandbox
configuration:

```bash
npm run verify:phase50:environment
```

For system release preparation, run the real private S3 verifier with its existing
Phase 49 real-S3 environment/retention/IAM attestations:

```bash
npm run verify:phase49:s3
```

No PASS may be inferred from Agent output such as `implementation completed` or
`tests passed`.

## 6. Final verification record

Persist the Phase 50 final record under `docs/verification/` after the command
sequence succeeds. The record must include:

```text
verification date
tested Git revision
Phase 50 child status
canonical-order result
alternate-order result
repeat-run result
golden contract result
blocking defect count
expected-failure count
S3 conformance summary
sandbox conformance summary
alternate coverage result
real S3 policy
sandbox real-environment policy
limitations
out-of-scope boundary
```

The tested revision in the final record and the tested revision in the refreshed
Phase 50 environment-conformance record must refer to the same final source state
or the difference must be explicitly explained and reverified before release.

## 7. Contract / roadmap alignment

At #5432 preparation time:

```text
Redmine Phase 50 parent children = 50-1 through 50-8
040_ロードマップ Phase 50 children = 50-1 through 50-8
expected-failure registry = empty
additional Phase 50 blocking-defect child = none
```

Repository references to Phase 50-6 and Phase 50-7 that describe their actual
reconciliation or restore responsibilities remain valid. The artifact handoff
contract is updated to remove the now-resolved Phase 50 decision placeholder.

Any newly discovered difference at final verification must be classified as one
of:

```text
implementation bug
documentation drift
intentional contract revision
```

Do not normalize an implementation bug into the golden baseline to make the gate
pass.

## 8. Phase 51 handoff

Phase 51 receives:

```text
final tested Git revision
canonical contract revisions
golden contract and drift guard
FI-01..FI-15 / SC-01..SC-07 ownership matrix
cross-phase deterministic integration result
S3/sandbox conformance evidence
real-S3 verification policy and latest release evidence
known environment assumptions
remaining release-only checks
known limitations
```

Phase 51 may prepare the v0.4.0 system compatibility milestone and verify
component/version compatibility. It does not redefine lifecycle ownership,
execution identity, artifact format, S3 deterministic key layout, or Source of
Truth boundaries.

## 9. Explicit exclusions

Phase 50 final verification does not add:

```text
Git push
CircleCI feedback loop
CI result feedback to Agent
Agent correction loop
automatic Agent retry
retry until CI passes
Pull Request automation
automatic merge
deployment automation
multiple Workers
multiple Runner instances
distributed claim / lease / heartbeat / queue
```
