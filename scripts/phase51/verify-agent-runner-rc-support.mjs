import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  gitBlobSha,
  importBuilt,
  parseCli,
  readJson,
  requiredOption,
  scriptRoot,
  writeJsonStdout,
} from "./common.mjs";
import { deriveConsumerProfile } from "./agent-runner-consumer-profile.mjs";
import { runPhase50BaselineProbe } from "./agent-runner-phase50-baseline-probe.mjs";

const REPOSITORY = "mcp-mamono210/ai-agent-runner";
const HANDOFF_MODULE = "src/agent-brief/handoff-binding.ts";
const FINGERPRINT_MODULE = "src/agent-brief/requirements-fingerprint-compat.ts";

function fieldFixture(profile, overrides = {}) {
  const positive = (id) => profile.constraints[id].positive[0];
  return {
    lifecycle: profile.lifecycle.readyForAgentValue,
    approvedBy: positive("redmine-principal-v1"),
    approvedAt: positive("rfc3339-offset-timestamp-v1"),
    approvedBriefRevision: positive("positive-safe-base10-integer-v1"),
    approvedPersistedRevision: positive("nonblank-opaque-string-v1"),
    approvedRequirementsFingerprint: positive("sha256-lowercase-hex-v1"),
    ...overrides,
  };
}

function issueProjection(profile, fields) {
  const mapping = [
    [profile.lifecycle.fieldName, fields.lifecycle],
    [profile.approval.approvedBy.fieldName, fields.approvedBy],
    [profile.approval.approvedAt.fieldName, fields.approvedAt],
    [profile.approval.approvedBriefRevision.fieldName, fields.approvedBriefRevision],
    [profile.approval.approvedPersistedRevision.fieldName, fields.approvedPersistedRevision],
    [profile.approval.approvedRequirementsFingerprint.fieldName, fields.approvedRequirementsFingerprint],
  ];
  return {
    issueId: 51001,
    projectId: 414,
    raw: {
      id: 51001,
      project: { id: 414, name: "Phase 51 fixture" },
      customFields: mapping.map(([name, value], index) => ({ id: index + 1, name, value })),
    },
  };
}

async function runValidation(Validator, profile, fields) {
  const verifier = { async verify() {} };
  const validator = new Validator({
    repository: "mcp-mamono210/redmine",
    approvedBriefVerifier: verifier,
  });
  return validator.validate(issueProjection(profile, fields));
}

async function assertConstraintConformance(root, profile) {
  const module = await importBuilt(root, "dist/src/agent-brief/handoff-binding.js");
  const Validator = module.Phase46HandoffValidator;
  const cases = [
    ["approvedBy", "redmine-principal-v1"],
    ["approvedAt", "rfc3339-offset-timestamp-v1"],
    ["approvedBriefRevision", "positive-safe-base10-integer-v1"],
    ["approvedPersistedRevision", "nonblank-opaque-string-v1"],
    ["approvedRequirementsFingerprint", "sha256-lowercase-hex-v1"],
  ];

  for (const [field, constraintId] of cases) {
    for (const value of profile.constraints[constraintId].positive) {
      const result = await runValidation(Validator, profile, fieldFixture(profile, { [field]: value }));
      if (!result.ok) {
        throw new Error(`production handoff validator rejected canonical positive vector for ${constraintId}: ${JSON.stringify(value)}`);
      }
    }
    for (const value of profile.constraints[constraintId].negative) {
      const result = await runValidation(Validator, profile, fieldFixture(profile, { [field]: value }));
      if (result.ok) {
        throw new Error(`production handoff validator accepted canonical negative vector for ${constraintId}: ${JSON.stringify(value)}`);
      }
    }
  }

  return {
    result: "PASS",
    matchedConstraintIds: Object.fromEntries(cases),
  };
}

function expectedFingerprintSources(root, producerVerificationPath) {
  const producer = readJson(producerVerificationPath);
  const sources = producer.current?.requirementsFingerprintImplementationSources;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("producer RC verification evidence does not expose requirements fingerprint implementation sources");
  }

  const compatSource = readFileSync(resolve(root, FINGERPRINT_MODULE), "utf8");
  const declared = new Map();
  for (const match of compatSource.matchAll(/- (src\/agent-brief\/[^ ]+) \(blob ([0-9a-f]{40})\)/gu)) {
    declared.set(match[1], match[2]);
  }

  for (const source of sources) {
    const expectedBlob = declared.get(source.path);
    if (expectedBlob === undefined) {
      throw new Error(`Agent Runner compatibility binding does not declare producer source ${source.path}`);
    }
    if (expectedBlob !== source.blobSha) {
      throw new Error(`Agent Runner expected producer blob drift for ${source.path}`);
    }
  }
  return structuredClone(sources);
}

function documentationReadiness(root) {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const normalizedReadme = readme.replace(/\s+/gu, " ");
  const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
  const requiredReadme = [
    "Current Phase 50 completion / Phase 51 RC boundary",
    "Ready for Independent Verification",
    "Git remote push",
    "automatic Agent retry",
    "Phase 51 RC evidence is canonical in `mcp-mamono210/redmine`",
  ];
  for (const token of requiredReadme) {
    if (!normalizedReadme.includes(token)) {
      throw new Error(`README readiness marker is missing: ${token}`);
    }
  }
  if (!changelog.includes("Phase 50") || !changelog.includes("[Unreleased]")) {
    throw new Error("CHANGELOG does not describe the Phase 50-complete unreleased state");
  }
  return {
    readme: "PASS",
    changelog: "PASS",
    responsibilityBoundary: "PASS",
    duplicateCanonicalCompatibilitySoT: false,
  };
}

export async function verifyAgentRunnerRcSupport({
  root,
  canonicalProfilePath,
  producerVerificationPath,
}) {
  const profile = deriveConsumerProfile({ root, canonicalProfilePath });
  const constraintConformance = await assertConstraintConformance(root, profile);
  const requirementsFingerprintExpectedImplementationSources = expectedFingerprintSources(
    root,
    producerVerificationPath,
  );
  const phase50Baseline = await runPhase50BaselineProbe({ root });

  return {
    result: "PASS",
    handoffConsumerProfile: profile,
    constraintConformance,
    requirementsFingerprintExpectedImplementationSources,
    productionBindings: {
      handoffValidationEntryPoint: {
        repository: REPOSITORY,
        module: HANDOFF_MODULE,
        exportedSymbol: "Phase46HandoffValidator",
      },
      requirementsFingerprintEntryPoint: {
        repository: REPOSITORY,
        module: FINGERPRINT_MODULE,
        exportedSymbol: "calculateAgentBriefRequirementsFingerprintCompat",
      },
    },
    probeBindings: {
      consumerProfileProbe: "scripts/phase51/agent-runner-consumer-profile.mjs",
      productionHandoffValidationProbe: "scripts/phase51/agent-runner-handoff-validation-probe.mjs",
      requirementsFingerprintCompatibilityProbe:
        "scripts/phase51/agent-runner-requirements-fingerprint-probe.mjs",
      phase50BaselineVerificationProbe: "scripts/phase51/agent-runner-phase50-baseline-probe.mjs",
    },
    currentBindingBlobs: {
      [HANDOFF_MODULE]: gitBlobSha(root, "HEAD", HANDOFF_MODULE),
      [FINGERPRINT_MODULE]: gitBlobSha(root, "HEAD", FINGERPRINT_MODULE),
    },
    phase50Baseline,
    documentationReadiness: documentationReadiness(root),
  };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invoked) {
  try {
    const options = parseCli(process.argv.slice(2));
    const root = options.get("root") || scriptRoot(import.meta.url);
    const canonicalProfilePath = requiredOption(options, "canonical-profile");
    const producerVerificationPath = requiredOption(options, "producer-verification");
    writeJsonStdout(
      await verifyAgentRunnerRcSupport({ root, canonicalProfilePath, producerVerificationPath }),
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
