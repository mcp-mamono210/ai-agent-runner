# Phase 49-2 Private S3 Persistence Contract

This document fixes the v0.4.0 runtime decisions for Redmine issue #5419.
It consumes the canonical single-object artifact contract established by #5418
and does not redefine the artifact manifest or execution identity.

## 1. Storage baseline

The v0.4.0 storage baseline is:

```text
one Phase 49 artifact object
+ direct PutObject only
+ If-None-Match: *
+ SHA-256 additional checksum
+ FULL_OBJECT checksum semantics
+ SSE-S3 (AES256)
+ bucket versioning disabled
```

Multipart upload is not used. The Controller does not fall back to multipart when
the #5418 artifact-size bound is exceeded.

The runtime uses `PutObjectCommand` directly. It does not use a managed uploader
that may switch to multipart internally.

## 2. Deterministic address and artifact_reference

The object key is derived only from the already-started immutable execution ID:

```text
<prefix>/<lowercase-uuidv4-execution-id>.json
```

Default prefix:

```text
phase49/artifacts
```

The durable Redmine reference format is:

```text
s3://<bucket>/<key>
```

The bucket/prefix are deployment location, not canonical artifact identity. The
canonical identity remains in the object-body manifest.

No `ListBucket` operation is needed to derive or read the object address.

## 3. Write and confirmation ordering

```text
built single artifact
-> PutObject
   If-None-Match: *
   ChecksumAlgorithm: SHA256
   ChecksumSHA256: expected full-object checksum
   ServerSideEncryption: AES256
-> HeadObject
   ChecksumMode: ENABLED
-> required metadata present
-> ChecksumSHA256 present
-> ChecksumType = FULL_OBJECT
-> SSE = AES256
-> version ID absent
-> identity projection matches
-> envelope checksum matches
-> persistence confirmed
```

A successful PutObject response alone is never durable success.

## 4. Existing object / ambiguous write recovery

A conditional conflict or an ambiguous PutObject result is recoverable only by
reading the deterministic object address and proving it is the same artifact.

```text
PutObject conflict / ambiguous result
-> HeadObject(ChecksumMode=ENABLED)
-> all required metadata present
-> identity projection exact match
-> FULL_OBJECT SHA-256 exact match
-> SSE-S3 exact match
-> matching object adopted
```

Missing checksum, missing metadata, mismatch, unexpected version ID, or other
ambiguity fails closed. Recovery does not reconstruct and byte-compare a new
local artifact and does not rerun the Agent.

## 5. Full verification

Paths that require canonical-body validation use GetObject:

```text
GetObject(ChecksumMode=ENABLED)
-> storage observation verification
-> canonical manifest parse
-> metadata/manifest consistency through expected identity
-> patch checksum verification
```

Phase 50 owns the complete clean-checkout restore E2E proof.

## 6. Encryption decision

Phase 49-2 selects SSE-S3 (`AES256`) for v0.4.0.

This avoids KMS permissions in the Controller credential while still requiring
encryption at rest. A future move to SSE-KMS is a contract change because
checksum-enabled reads then require the applicable KMS permissions and the
S3 Bucket Key decision must be revisited.

## 7. Controller IAM boundary

Controller object access is limited to the configured artifact prefix.
The intended identity-policy actions are:

```text
s3:PutObject
s3:GetObject
```

`HeadObject` is authorized through `s3:GetObject`.

The Controller is not granted by default:

```text
s3:DeleteObject
s3:ListBucket
s3:PutObjectAcl
s3:PutObjectTagging
```

The bucket policy must additionally require conditional creation for PutObject.
A deployment policy should deny writes to the artifact prefix when the
`If-None-Match` condition is absent.

Because no `ListBucket` permission is granted, a missing object may surface as
403 instead of 404. Runtime code therefore does not reinterpret access denied as
"artifact absent"; it fails closed. Phase 49-5 owns startup-reconciliation
classification around this boundary.

## 8. Versioning / immutability

Bucket versioning is disabled for the v0.4.0 baseline. The Controller also has no
DeleteObject permission. Conditional creation prevents silent replacement of an
existing key.

A Head/Get response carrying a version ID is rejected by this runtime because it
indicates that the selected bucket does not match the baseline.

CopyObject/archive/migration workflows are not assumed to work on the protected
prefix and are outside Phase 49-2.

## 9. Retention

Phase 49 v0.4.0 requires a minimum durable retention window of **30 days** for
completed artifacts. Bucket lifecycle provisioning is deployment-owned rather
than Controller-owned so the Controller does not need bucket-management IAM
permissions.

The lifecycle must not expire a completed artifact before the Independent
Verification and Phase 50 restore windows have finished. Phase 49-5 records the
real-bucket lifecycle configuration during final verification.

## 10. Runtime configuration

Required:

```text
AGENT_RUNNER_ARTIFACT_S3_REGION
AGENT_RUNNER_ARTIFACT_S3_BUCKET
```

Optional:

```text
AGENT_RUNNER_ARTIFACT_S3_PREFIX
AGENT_RUNNER_ARTIFACT_S3_EXPECTED_BUCKET_OWNER
```

The prefix defaults to `phase49/artifacts`. The expected bucket owner, when set,
must be a 12-digit AWS account ID and is sent on Put/Head/Get operations.

AWS credentials remain Controller-owned and are resolved by the AWS SDK default
credential provider chain. They are never included in artifact bytes, metadata,
Redmine fields, Agent input, or diagnostics.

## 11. First-write Compatibility Gate

Before Phase 49-4 begins, a disposable fixture Issue on the same Redmine instance
used by the production Controller must prove exact write/read-back for:

```text
Agent Execution Lifecycle = Ready for Independent Verification
Agent Execution Outcome = artifact_persistence_failed
Agent Artifact Reference = representative production-format s3:// reference
```

`RedminePhase49FirstWriteCompatibilityVerifier` resolves the fields by exact name,
writes the representative values once, re-fetches the Issue, and requires exact
scalar read-back. A fixture outside the Controller's allowed projects is rejected.

A different Redmine instance may be used only when its custom-field definitions,
field types, option lists, and validation/length constraints are proven equivalent.

The verifier is deliberately not invoked during normal startup. A fixture Issue
ID must be supplied explicitly by the operator/test harness.

## 12. Verification ownership

Phase 49-2 unit tests cover:

- conditional PutObject request contract;
- checksum-enabled HeadObject confirmation;
- missing checksum/metadata fail-closed behavior;
- existing matching-object adoption after conflict/ambiguous write;
- mismatched-object rejection;
- deterministic addressing without ListBucket;
- SSE-S3 and versioning baseline checks;
- GetObject full verification;
- First-write Redmine exact read-back behavior.

Real private S3 verification remains the Phase 49-5 final gate.
