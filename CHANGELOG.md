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
- Prepared the Phase 52-3 system-release documentation boundary after the Phase 52-1 Real Private S3 and Phase 52-2 Environment Conformance gates passed, without declaring v0.4.0 Released.
- Clarified that the current RC has production runtime composition / dependency assembly but no accepted resident-service startup surface, service supervision / deployment definition, or dedicated GCE deployment acceptance.
- Clarified that v0.4.0 credential acceptance covers design / implementation ownership and non-exposure separation, while deployed credential / principal identity separation and deployment-host Environment Conformance rerun remain later Deployment / Operations responsibilities.

### Release boundary

The current system-milestone behavior is:

```text
Ready for Agent
-> safe one-shot Agent execution
-> durable immutable artifact
-> Ready for Independent Verification
```

The following remain outside the v0.4.0 system-milestone scope: Git remote push, CI feedback to the Agent, Agent correction/retry loops, Pull Request automation, merge/deploy automation, resident production-service startup / supervision, dedicated GCE deployment acceptance, deployment-time credential / principal identity verification, and distributed/multi-worker execution.

The separate-GCE architecture boundary remains unchanged. Deployment acceptance and actual deployed principal separation are deferred responsibilities, not claims made by the v0.4.0 system milestone.

The Agent Runner component version remains independently selected. This changelog does not make the v0.4.0 system milestone a component-version identity.
