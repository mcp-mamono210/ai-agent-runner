# Phase 51-3 Agent Runner RC operational runbook

This directory is verification support for Redmine issue #5436. It is not a
second compatibility Source of Truth. Canonical Phase 51 contracts and canonical
RC evidence remain in `mcp-mamono210/redmine`.

The Agent Runner RC must be frozen only after these verification-support files
have been committed. Do not create the canonical RC evidence from an earlier
revision and then add probes afterward.

## Inputs from the canonical Redmine repository

Use a current Redmine checkout containing completed Phase 51-1 and Phase 51-2
records. The examples below assume it is available next to this repository:

```bash
REDMINE_REPO=../redmine
CANONICAL_PROFILE="$REDMINE_REPO/docs/contracts/system-release-handoff-profile.json"
CONTRACT_REGISTRY="$REDMINE_REPO/docs/contracts/system-release-compatibility-contract-registry.json"
PRODUCER_VERIFICATION="$REDMINE_REPO/docs/verification/phase51-redmine-mcp-rc-verification.json"
```

These files are read as inputs only. Do not copy them into Agent Runner.

## 1. Prepare verification support before RC identity

Build the production modules consumed by the probes:

```bash
npm run build
```

Verify that the consumer profile is derived from the production handoff validator,
that every canonical positive/negative constraint vector has the expected
production result, that the requirements-fingerprint compatibility binding still
matches the producer source identities, and that the Phase 50 golden baseline is
still current:

```bash
node scripts/phase51/verify-agent-runner-rc-support.mjs \
  --canonical-profile "$CANONICAL_PROFILE" \
  --producer-verification "$PRODUCER_VERIFICATION"
```

Run the ordinary repository regressions:

```bash
npm run lint
npm run typecheck
npm run test:unit
```

Commit the Phase 51-3 verification-support/documentation changes. That commit is
the earliest revision eligible to become the Agent Runner RC source revision.

## 2. Freeze the exact RC source revision

Immediately after the support commit:

```bash
RC_SOURCE_REVISION="$(git rev-parse HEAD)"
```

The collector intentionally requires `HEAD == RC_SOURCE_REVISION`. Run it before
later evidence-only commits:

```bash
node scripts/phase51/collect-agent-runner-rc-evidence-input.mjs \
  --source-revision "$RC_SOURCE_REVISION" \
  --canonical-profile "$CANONICAL_PROFILE" \
  --producer-verification "$PRODUCER_VERIFICATION" \
  --contract-registry "$CONTRACT_REGISTRY" \
  > /tmp/phase51-agent-runner-rc-evidence-input.json
```

The output is component-local input for canonical evidence generation. It is not
itself canonical Phase 51 evidence and should not be committed as a competing
record in this repository.

For the current #5436 scope, only README/CHANGELOG, tests, and `scripts/phase51/**`
should change after Phase 50 closure. The classifier therefore expects the runtime
artifact and externally observable component contract to remain unchanged. If it
reports `NEW_COMPONENT_VERSION_REQUIRED`, stop and make an independent component
version decision before freezing RC identity.

The current package version is allowed to remain independent from the v0.4.0
system milestone. If a future independent decision chooses exactly `0.4.0`, the
canonical RC identity evidence must record why that same number was selected
without using the system milestone as an input.

## 3. Run the canonical Phase 50 / environment gate on the RC

Run the repository's existing Phase 50 environment gate against the exact RC
checkout:

```bash
npm run verify:phase50:environment
```

This is the Agent Runner release-quality/environment gate. Phase 51 does not
restate its internal command list as a second verification contract.

If this command regenerates component-local Phase 50 evidence bytes, capture the
PASS result/reference needed for Phase 51 evidence and do not silently move
`RC_SOURCE_REVISION` to an evidence-only commit.

## 4. Change-triggered real private S3 decision

The RC classifier evaluates changes since the Phase 50 closure and records these
triggers:

```text
artifact contract changed?
S3 SDK / persistence changed?
IAM boundary changed?
encryption changed?
lifecycle changed?
```

If all are false, the Phase 51 change-triggered result is:

```text
NOT_REQUIRED_WITH_REASON
```

with the generated rationale.

If any trigger is true, do not convert the result to PASS without running the
required change-triggered real private S3 verification and recording its raw
evidence.

Regardless of this Phase 51 decision:

```text
Phase 52 system-release mandatory real private S3 = still required
Phase 52 system-release environment conformance  = still required
```

Phase 51 never satisfies those Phase 52 release-only gates in advance.

## 5. Canonical evidence is persisted in Redmine repository

After the exact Agent Runner RC has passed the required gate, persist these
canonical records in `mcp-mamono210/redmine`:

```text
docs/verification/phase51-agent-runner-rc-identity.json
docs/verification/phase51-agent-runner-rc-verification.json
docs/verification/phase51-agent-runner-real-infrastructure-decision.json
```

The canonical records must keep the verification-support commit as
`exactSourceRevision`. A later Redmine evidence commit is not the Agent Runner RC
source revision.

At minimum the canonical records consume the collector output plus:

```text
executed gate identity
Phase 50/environment result
raw execution reference
executedAt
change-triggered real S3 PASS evidence when required
```

Phase 51-4 then consumes the exact RC identity, verification record, consumer
profile, production bindings, probes, and real-infrastructure decision.
