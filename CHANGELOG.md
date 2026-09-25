# Changelog

All notable Agent Runner changes are recorded here.

## [Unreleased]

### Added

- Added the Phase 48 one-shot Agent execution path from `Ready for Agent` through exact-source execution preparation, sandboxed Codex invocation, bounded failure handling, and startup reconciliation.
- Added Phase 49 immutable single-object artifact generation, private S3 persistence, successful Redmine finalization, and `Ready for Independent Verification` handoff.
- Added Phase 50 machine-verifiable contract baselines, deterministic fault/regression coverage, environment conformance, and final verification evidence.
- Added Phase 51 verification-only consumer-profile, handoff-validation, requirements-fingerprint compatibility, Phase 50 baseline, RC change-classification, and evidence-input probes.

### Changed

- Recorded the released `v0.4.0` system milestone identified by Redmine repository tag `system-v0.4.0` and canonical evidence generation `sha256:b1ffbad2e092b371d0ce1e9c1d8dfc0c144104b382243a031e8e9b73181d658a`.
- Recorded the compatible Redmine MCP identity as `0.3.0` at `2b2bd1c42f1caaf876da02da0adc67dd698ddff4` and Agent Runner identity as `0.0.0` at `bc4e58a2f9986b88a7eb84b191d85824c926f9f7` while keeping Agent Runner component versioning independent.
- Kept the system functional boundary at `Ready for Independent Verification`.
- Clarified that this release is not a resident production-service deployment release; executable startup, service supervision / deployment definition, dedicated GCE deployment acceptance, deployed principal separation, and deployment-host Environment Conformance remain deferred.

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
