# Phase 49 Artifact Contract

Status: canonical implementation contract for Redmine #5418 / Phase 49-1.

This document binds the Phase 48 provisional success handoff to the durable
artifact boundary owned by Phase 49. It does not implement S3 I/O, Redmine
successful finalization, reconciliation, Git push, CI, or PR automation.

## 1. Fixed v0.4.0 decisions

Phase 49-1 fixes the following choices for v0.4.0:

```text
artifact composition       = single object
body format                = canonical UTF-8 JSON
patch representation       = git diff --binary compatible text
artifact format version    = phase49.single.v1
patch checksum             = SHA-256, lowercase hex
artifact envelope checksum = SHA-256 FULL_OBJECT
upload mode                = direct PutObject only
multipart                  = not used / no automatic fallback
maximum artifact size      = 8 MiB
metadata verification      = HeadObject + ChecksumMode=ENABLED
full verification          = GetObject
metadata budget            = 1536 bytes including x-amz-meta-* key names
secret policy              = no patch mutation/scanning in Phase 49
canonical failure outcome  = artifact_persistence_failed
```

The 8 MiB artifact limit intentionally leaves headroom above the existing Phase
48-7 default 4 MiB development patch-capture boundary while remaining far below
the S3 single-PutObject service limit. A truncated Phase 48 patch is invalid and
must never be persisted as a successful artifact.

If a future phase needs larger artifacts, multipart upload must be redesigned as
a group with checksum type, conditional completion, lifecycle cleanup, and
read-back semantics. Phase 49 must not silently switch to a managed multipart
uploader.

## 2. Source-of-truth and identity

The canonical artifact identity is stored in the object-body manifest.

```text
execution_id
issue_id
repository
source_revision
brief_revision
persisted_revision
requirements_fingerprint
outcome
```

All identity comes from the immutable Phase 48 started execution input. Phase 49
must not re-fetch mutable Redmine or Git state to reconstruct or retarget it.

S3 user metadata is only a bounded verification projection. It is never the
canonical identity Source of Truth.

## 3. Single-object envelope

The object is canonical JSON with exactly two top-level fields:

```json
{
  "manifest": { "...": "canonical manifest" },
  "patch": "exact git diff --binary compatible text"
}
```

Object keys are serialized in lexicographic order. The changed-file list is
sorted by path/status before serialization. Undefined and non-finite values are
not valid canonical JSON.

The manifest contains:

```text
artifact format version
execution identity
outcome
changed-file information
patch format
git patch SHA-256
patch checksum algorithm
```

The exact patch string is preserved. Git binary-diff text carries binary
changes, file modes, symlink changes, deletions, and additions. Phase 48 uses
`--no-renames`, so rename/copy results are intentionally represented as the
corresponding delete/add final-tree operations rather than requiring rename
identity. Empty untracked files still produce Git new-file patch metadata and
remain restorable.

Phase 50 owns the clean-checkout restore proof.

## 4. Outcome/change-set consistency

```text
changes_ready + non-empty changed files + non-empty patch = valid
changes_ready + empty changed files or empty patch         = invalid
no_changes    + empty changed files + empty patch          = valid
no_changes    + non-empty changed files or patch           = invalid
```

No silent outcome rewriting is allowed.

`no_changes` is a successful empty artifact result. It is not artifact absence.

## 5. Outcome taxonomy decision

Phase 49-1 does not add a new Redmine durable outcome. For v0.4.0, the existing
Phase 45 value is retained:

```text
artifact_persistence_failed
```

It is the durable Phase 49 artifact-pipeline failure outcome for storage,
integrity, artifact-size/policy, secret-policy rejection, and Agent-result
validation failures. The concrete cause must remain distinguishable in bounded
internal reason/diagnostic data; the Redmine outcome field is not expanded in
Phase 49.

This is an explicit compatibility decision, not an implicit conflation. A later
phase may split the taxonomy only by first updating the Phase 45 canonical
contract and provisioning Redmine values.

## 6. Secret policy decision

Phase 49-1 selects the non-mutating policy:

```text
patch secret scanning/redaction = not performed in Phase 49
private S3 access boundary      = required
S3 encryption at rest           = required by Phase 49-2
```

Generic redaction must not rewrite patch bytes because that would change the
change-set semantics. Metadata, diagnostics, and summaries continue to use the
existing reusable redaction boundary. Full deterministic secret-persistence
regression remains a Phase 50 handoff item.

## 7. Integrity

Two checksums exist for different responsibilities:

```text
patch checksum
= SHA-256 of exact UTF-8 serialized patch bytes
= lowercase hex in manifest + metadata projection

artifact envelope checksum
= SHA-256 of exact canonical object bytes
= supplied to S3 PutObject
= retrieved from S3 as Base64 ChecksumSHA256
```

Direct `PutObject` is required so SHA-256 is a FULL_OBJECT checksum. Phase 49
must reject a `COMPOSITE` checksum type.

Normal verification requires:

```text
HeadObject
ChecksumMode = ENABLED
checksum type = FULL_OBJECT
ChecksumSHA256 present
all required metadata fields present
all required values non-null/non-undefined
identity projection matches expected started identity
ChecksumSHA256 matches expected envelope checksum
```

Missing verification data is failure, not a skipped comparison:

```text
comparison target absent != comparison success
```

Full verification uses `GetObject`, parses the canonical manifest, validates the
patch checksum, and fails if metadata and manifest disagree.

## 8. Metadata projection

Keys are fixed, lowercase, and kebab-case:

```text
artifact-format-version
execution-id
issue-id
repository
source-revision
brief-revision
persisted-revision
requirements-fingerprint
outcome
patch-checksum
```

Underscore and mixed-case variants are invalid contract keys. Read-back lookup
also uses lowercase keys because S3 normalizes user metadata keys to lowercase.

The following values are stored as bounded ASCII directly:

```text
artifact-format-version
execution-id
issue-id
brief-revision
outcome
patch-checksum
```

Potentially non-ASCII/arbitrary strings use deterministic UTF-8 -> base64url
projection:

```text
repository
source-revision
persisted-revision
requirements-fingerprint
```

The original values remain in the canonical manifest.

Changed-file information, execution summaries, diagnostics, patch payload, and
other unbounded strings are prohibited from the metadata projection.

The implementation enforces a conservative 1536-byte budget including the
`x-amz-meta-` key names, leaving margin below S3's user-defined metadata limit.
No truncation is allowed.

Metadata is written atomically with object creation and is not independently
mutated. Conditional immutable creation prevents replacement of the same object
key in the Phase 49 baseline.

## 9. Idempotent recovery contract handed to Phase 49-2

The builder returns both the lowercase-hex envelope checksum and the Base64 form
used by S3 `ChecksumSHA256`.

If a direct conditional PutObject succeeds remotely but the response is lost,
a retry may encounter the existing object. Phase 49-2 must then request:

```text
HeadObject(ChecksumMode=ENABLED)
```

and compare the stored metadata projection and S3 checksum to the expected
artifact. A complete match is an already-completed persistence operation, not
an Agent retry or new execution. Missing/mismatched verification data fails
closed.

The comparison does not require rebuilding a local artifact byte-for-byte.

## 10. First-write Compatibility Gate handed to Phase 49-2/49-4

Before Phase 49-4 starts, the actual Redmine environment must prove write and
exact read-back compatibility for values first exercised by Phase 49:

```text
Agent Execution Lifecycle = Ready for Independent Verification
Agent Execution Outcome   = artifact_persistence_failed
Agent Artifact Reference  = Phase 49-2 production reference format
```

No new outcome is introduced by Phase 49-1, so no new outcome provisioning is
required by this ticket. If that decision changes later, Phase 45 contract
update and Redmine option provisioning must precede Phase 49-4.

Verification should use a disposable fixture Issue on the same Redmine instance
used by the production Controller. If another instance is used, custom-field
types, list options, length constraints, and validations must be shown to match.

## 11. Phase 49-1 verification coverage

The Phase 49-1 unit suite includes explicit regression coverage for the policy
boundaries owned by this ticket:

```text
artifact body > 8 MiB
-> rejected

metadata projection > 1536 bytes
-> rejected

representative Git edge cases
(binary, file mode, deletion, rename-as-delete/add, copy-as-untracked,
symlink, untracked file, empty file)
-> collected with Phase 48-compatible git diff semantics
-> packaged into the single artifact
-> extracted patch passes git apply --check on a clean source_revision worktree
```

This is contract-level coverage only. Phase 50 still owns the full deterministic
restore E2E proof.

## 12. Phase 50 restore handoff

Phase 50 must be able to perform:

```text
clean checkout at exact source_revision
+ GetObject durable artifact
+ canonical manifest verification
+ patch checksum verification
+ exact patch extraction
+ patch application
```

without introducing a new artifact architecture.
