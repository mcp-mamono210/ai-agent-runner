# Phase 50-1 Contract Baseline / Golden Guard

Issue: #5425

This document records the initial Phase 50 machine-verifiable baseline. It does
not make the current implementation authoritative. The JSON baseline is derived
from the Phase 45-49 canonical contracts first and is then compared with the
current Agent Runner implementation.

## Source revisions

Canonical Phase 45-47 contracts:

```text
repository: mcp-mamono210/redmine
revision: facfacebd6854651721eb41aaff8cdb4e5a3cdfa
```

Runner implementation / Phase 48-49 verification inputs:

```text
repository: mcp-mamono210/ai-agent-runner
revision: a1813f9a70dbec5a1a342669c3941e8521941006
```

Exact source paths are pinned in:

```text
docs/contracts/phase50-contract-baseline.json
```

## Golden declarations

The baseline fixes three machine-readable surfaces required by #5425:

```text
execution lifecycle/outcome identities
Phase 49 artifact format/schema/persistence invariants
Controller application-required S3 IAM actions
```

The lifecycle set is:

```text
Ready for Agent
Agent Running
Ready for Independent Verification
Needs Human
```

The outcome set is:

```text
changes_ready
no_changes
stale_requirements
eligibility_failed
interrupted
timeout
agent_start_failed
agent_failed
artifact_persistence_failed
```

The artifact baseline preserves the existing Phase 49 single-object contract,
including `phase49.single.v1`, canonical manifest + patch envelope, the required
metadata field set, SHA-256 / FULL_OBJECT integrity, 8 MiB maximum object size,
direct conditional PutObject, deterministic execution-id-derived object key,
and SSE-S3 AES256.

The Controller application-required S3 action baseline is:

```text
required:
  s3:PutObject
  s3:GetObject

not required:
  s3:DeleteObject
  s3:ListBucket
```

This is an application requirement declaration, not a substitute for inspecting
the deployed AWS IAM policy.

## Implementation projection

`src/verification/phase50-contract-baseline.ts` projects the current runtime
contract from existing implementation values. In particular:

- pre-execution and started-execution outcome unions now have runtime constants
  from which their TypeScript types are derived;
- Phase 49 artifact constants and a real artifact build are used to project the
  format, envelope fields, manifest fields, metadata keys, checksum rules, and
  maximum size;
- the existing deterministic S3 key function remains the object-address source;
- the Controller IAM requirement is an explicit machine-readable declaration.

The guard test compares this projection to the canonical JSON baseline. The
baseline therefore does not get regenerated from implementation output.

## Drift classification at baseline creation

For the fields covered by the machine-readable baseline, no blocking drift was
identified between the pinned canonical contracts and the pinned current
implementation.

```text
documentation drift: 0
implementation bug: 0
intentional contract revision: 0
blocking defects: 0
```

If a later run detects implementation drift, the canonical baseline remains
unchanged. An implementation bug must be tracked as a 0.4.0 Phase 50 blocking
defect instead of updating the golden file to make the test pass.

## Expected-failure registry

The registry is:

```text
docs/verification/phase50-expected-failures.json
```

It is intentionally empty at baseline creation. A future known implementation
failure must include a test identity, Redmine blocking-defect ID, exact expected
failure reason, canonical contract reference, and detected date.

The guard semantics are strict:

```text
expected exact failure -> registered known FAIL
unexpected PASS        -> XPASS -> failure
unrelated failure      -> failure
```

Anonymous or permanent skips are not a replacement for this registry. Phase
50-2 requires both open blocking drift and expected-failure markers to be zero.

## Negative controls

`tests/unit/phase50-contract-baseline.test.ts` proves the guard itself is active
by intentionally mutating copies of the golden contract for:

```text
canonical lifecycle rename
canonical outcome addition
artifact manifest schema change
Controller IAM action expansion
```

Each mutation must be rejected by the golden-contract comparison.
