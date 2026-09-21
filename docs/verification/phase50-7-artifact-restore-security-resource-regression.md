# Phase 50-7 Artifact Restore / Security / Secret / Resource Regression

Issue: #5431

This regression closes the Phase 49 restore handoff and re-verifies the Phase
47-49 sandbox, credential, secret, network, output, and workspace-resource
boundaries. It uses production components directly and does not introduce a
second artifact format, a second lifecycle authority, or a new restore-time
Redmine mutation path.

## Scope

Phase 50-7 owns four verification surfaces:

1. deterministic restore from a clean exact-source checkout plus the durable
   Phase 49 artifact;
2. restore failure classification, including FI-12 / FI-13 / SC-07;
3. Agent sandbox credential, mount, network, output, and disk boundaries;
4. synthetic-secret persistence/redaction behavior without generic patch
   rewriting.

Restart lifecycle convergence remains Phase 50-6. Cross-phase release closure
and Phase 51 handoff remain Phase 50-8.

## Artifact restore proof

The regression creates a real local Git repository and a bare remote fixture.
It records an exact source revision, builds a real `git diff --binary` patch,
persists that patch through `Phase49S3ArtifactPersistence`, advances the remote
`main` branch, and then deletes the original development workspace.

Restore then starts from a new empty directory and performs:

```text
clean repository
-> fetch exact source_revision
-> checkout --detach exact source_revision
-> Phase49S3ArtifactPersistence.recoverAndVerify()
-> canonical body / checksum / metadata / identity verification
-> extract exact serialized patch
-> git apply --check --binary
-> git apply --binary
```

The test proves that the remote branch HEAD differs from `source_revision` and
that the restore checkout remains fixed to the original source revision. It also
proves that the original workspace no longer exists before restore begins.

`no_changes` follows the same durable-artifact retrieval and verification path.
Its patch is the canonical empty patch, so restore performs no patch mutation
and verifies that the clean checkout remains clean. Artifact absence is not used
as the `no_changes` representation.

## Restore failure matrix

FI-12 and FI-13 are consumed through the shared Phase 50 deterministic harness
and must propagate as HeadObject / GetObject restore failures. Neither may be
converted into `not_found`.

SC-07 is consumed for:

- missing checksum;
- checksum mismatch;
- missing metadata;
- metadata mismatch;
- corrupt body.

Additional restore-only fixtures cover:

- explicit artifact absence (`not_found`);
- metadata/manifest mismatch;
- patch checksum mismatch;
- unsupported artifact format;
- started identity mismatch.

Every case asserts an expected reason or typed failure category. A generic
"restore failed" exception is not sufficient coverage.

## Finalized lifecycle boundary

Artifact restore/verification has no lifecycle writer dependency. An invalid
artifact therefore fails independent-verification restore without introducing a
Phase 50-7 rollback to `Agent Running`. Phase 50-6 remains authoritative for
startup lifecycle convergence.

## Sandbox credential and mount boundary

`DockerSandboxRuntime` is exercised through its production isolation checks.
The regression proves that container creation and Codex execution do not expose:

- `REDMINE_WRITE_API_KEY` or other Redmine API credentials;
- repository credential environment variables;
- `CONTROL_PLANE_API_KEY`;
- Docker/container-engine control sockets.

The created Agent container has exactly one host-backed writable mount: the
attempt-scoped workspace at `/workspace`. Injecting a forbidden Controller
credential into the inspected container environment fails closed. Injecting a
Docker socket host mount also fails closed.

The Codex execution argv forwards only the provider credential name
`CODEX_API_KEY` (plus Codex home configuration), not Controller or repository
credentials.

## Network regression / FI-15

FI-15 is consumed through the shared Phase 50 harness. The production
`DockerSandboxRuntime` path is also tested with a non-internal Docker network.
The operation fails before container creation with the security reason that the
sandbox network must be internal. There is no unrestricted-egress fallback.

## Output and workspace resource regression

SC-02 produces deterministic output larger than a configured capture bound. The
production `BoundedUtf8Capture` is then measured to retain only the configured
bytes and set `truncated=true`.

SC-03 produces deterministic workspace consumption above a configured limit.
The production `TaskWorkspaceManager` measures the real filesystem and rejects
the over-limit workspace.

The committed Phase 50 environment conformance record is also parsed with the
production conformance parser. Network, workspace-disk, output-capture, and
container-lifecycle findings must either be compatible or have executed,
evidenced alternate coverage. This prevents CI/environment differences from
being silently treated as PASS.

## Synthetic secret regression

The fixture uses the literal synthetic value:

```text
phase50-7-synthetic-secret-fixture
```

No real credential is read or copied into the secret fixture.

`CodexCliAgentAdapter` is exercised with the synthetic value in Agent output and
diagnostics. The reusable `KnownSecretRedactor` removes the value before those
captures are returned to downstream handoff logic. Runtime-diagnostic and
artifact-metadata redaction contexts are also checked.

The Phase 48-7 execution summary contains only bounded structural counts and
flags, so the synthetic secret does not appear there. Phase 49 metadata likewise
does not carry output, diagnostic, summary, or patch payload text.

The patch itself intentionally contains the synthetic secret. The generated
Phase 49 artifact must preserve those exact patch bytes. This fixes the Phase 49
decision:

```text
generic patch redaction = not performed
```

Secret safety for patch content is therefore provided by the private artifact
access boundary, not by silently changing the change-set.

## Production components under regression

- `Phase49S3ArtifactPersistence`
- `buildPhase49Artifact` / `buildPhase49ArtifactFromDevelopmentHandoff`
- `DockerSandboxRuntime`
- `CodexCliAgentAdapter`
- `Phase48_7ProvisionalResultHandler`
- `BoundedUtf8Capture`
- `TaskWorkspaceManager`
- `KnownSecretRedactor`
- Phase 50 fault/scenario harness
- Phase 50 conformance parser and committed environment-conformance record

No production source file is changed by this ticket.

## Verification

Run the complete environment gate so real sandbox/S3 conformance remains
non-skipped:

```bash
npm run verify:phase50:environment
```

For local code-only iteration:

```bash
npm run lint &&
npm run typecheck &&
npm run test:unit
```
