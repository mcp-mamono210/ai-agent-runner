# Changelog

All notable Agent Runner changes are recorded here.

## [Unreleased]

### Added

- Added the Phase 48 one-shot Agent execution path from `Ready for Agent` through exact-source execution preparation, sandboxed Codex invocation, bounded failure handling, and startup reconciliation.
- Added Phase 49 immutable single-object artifact generation, private S3 persistence, successful Redmine finalization, and `Ready for Independent Verification` handoff.
- Added Phase 50 machine-verifiable contract baselines, deterministic fault/regression coverage, environment conformance, and final verification evidence.
- Added Phase 51 verification-only consumer-profile, handoff-validation, requirements-fingerprint compatibility, Phase 50 baseline, RC change-classification, and evidence-input probes.

### Changed

- Updated component documentation to describe the Phase 50-complete v0.4.0 system-milestone boundary rather than the historical Phase 48-1-only slice.

### Release boundary

The current system-milestone behavior is:

```text
Ready for Agent
-> safe one-shot Agent execution
-> durable immutable artifact
-> Ready for Independent Verification
```

The following remain outside the v0.4.0 system-milestone scope: Git remote push, CI feedback to the Agent, Agent correction/retry loops, Pull Request automation, merge/deploy automation, and distributed/multi-worker execution.

The Agent Runner component version remains independently selected. This changelog does not make the v0.4.0 system milestone a component-version identity.
