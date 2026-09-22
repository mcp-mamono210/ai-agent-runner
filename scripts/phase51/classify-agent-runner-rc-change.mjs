import { resolve } from "node:path";

import {
  SYSTEM_MILESTONE_VERSION,
  assertRevisionIsAncestor,
  fail,
  git,
  parseCli,
  readJson,
  requireRevision,
  requiredOption,
  scriptRoot,
  writeJsonStdout,
} from "./common.mjs";

function listChangedPaths(root, baseRevision, sourceRevision) {
  const text = git(root, ["diff", "--name-only", `${baseRevision}..${sourceRevision}`]);
  return text === "" ? [] : text.split("\n").filter(Boolean);
}

function anyPath(paths, predicate) {
  return paths.some(predicate);
}

function classifyPaths(paths) {
  const runtimeArtifactChanged = anyPath(paths, (path) =>
    path.startsWith("src/") ||
    path === "package.json" ||
    path === "package-lock.json" ||
    path === ".nvmrc" ||
    path === "tsconfig.json",
  );

  const publicContractChanged = anyPath(paths, (path) =>
    path.startsWith("docs/contracts/") &&
    !path.startsWith("docs/contracts/phase50-") &&
    !path.startsWith("docs/contracts/phase51-"),
  );

  const artifactContractChanged = anyPath(paths, (path) =>
    path.includes("phase49-artifact") ||
    path.startsWith("src/artifact/") ||
    path.includes("artifact-store") ||
    path.includes("artifact-persistence"),
  );

  const s3SdkOrPersistenceChanged = anyPath(paths, (path) =>
    path === "package.json" ||
    path === "package-lock.json" ||
    path.includes("s3") ||
    path.includes("artifact-store") ||
    path.includes("artifact-persistence"),
  );

  const iamBoundaryChanged = anyPath(paths, (path) =>
    path.includes("iam") ||
    path.includes("security-sandbox") ||
    path.includes("phase49-s3-persistence"),
  );

  const encryptionChanged = anyPath(paths, (path) =>
    path.includes("encryption") ||
    path.includes("phase49-s3-persistence") ||
    path.includes("artifact-store"),
  );

  const lifecycleChanged = anyPath(paths, (path) =>
    path.startsWith("src/controller/") ||
    path.startsWith("src/redmine/") ||
    path.includes("lifecycle") ||
    path.includes("execution-boundary"),
  );

  return {
    runtimeArtifactChanged,
    publicContractChanged,
    artifactContractChanged,
    s3SdkOrPersistenceChanged,
    iamBoundaryChanged,
    encryptionChanged,
    lifecycleChanged,
  };
}

export function classifyAgentRunnerRcChange({ root, sourceRevision }) {
  requireRevision(root, sourceRevision);
  assertRevisionIsAncestor(root, sourceRevision);

  const phase50FinalRecordPath = resolve(
    root,
    "docs/verification/phase50-final-verification-20260921.json",
  );
  const phase50FinalRecord = readJson(phase50FinalRecordPath);
  if (phase50FinalRecord.result !== "PASS") {
    fail("Phase 50 final verification record must be PASS before Phase 51 RC classification");
  }

  const phase50ClosureRevision = git(root, [
    "rev-list",
    "-1",
    sourceRevision,
    "--",
    "docs/verification/phase50-final-verification-20260921.json",
  ]);
  requireRevision(root, phase50ClosureRevision);

  const changedPaths = listChangedPaths(root, phase50ClosureRevision, sourceRevision);
  const classification = classifyPaths(changedPaths);
  const packageAtCandidate = JSON.parse(
    git(root, ["show", `${sourceRevision}:package.json`]),
  );
  const componentVersion = packageAtCandidate.version;
  if (typeof componentVersion !== "string" || componentVersion.trim() === "") {
    fail("candidate package.json does not contain a component version");
  }

  const versionDecision =
    classification.runtimeArtifactChanged || classification.publicContractChanged
      ? "NEW_COMPONENT_VERSION_REQUIRED"
      : "REUSE_CURRENT_COMPONENT_VERSION";

  const realInfrastructureRequired =
    classification.artifactContractChanged ||
    classification.s3SdkOrPersistenceChanged ||
    classification.iamBoundaryChanged ||
    classification.encryptionChanged ||
    classification.lifecycleChanged;

  const nonRuntimeOnly = !classification.runtimeArtifactChanged && !classification.publicContractChanged;

  return {
    componentVersion,
    exactSourceRevision: sourceRevision,
    previousComponentIdentity: {
      phase50ClosureRevision,
      phase50TestedRevision: phase50FinalRecord.testedGitRevision,
      phase50EvidenceCommitRevision: phase50FinalRecord.evidenceCommitRevision,
      componentVersion: JSON.parse(git(root, ["show", `${phase50ClosureRevision}:package.json`])).version,
    },
    runtimeArtifactComparison: {
      baselineRevision: phase50ClosureRevision,
      result: classification.runtimeArtifactChanged ? "CHANGED" : "UNCHANGED",
      changedRuntimePaths: changedPaths.filter((path) =>
        path.startsWith("src/") || ["package.json", "package-lock.json", ".nvmrc", "tsconfig.json"].includes(path),
      ),
    },
    publicContractComparison: {
      baselineRevision: phase50ClosureRevision,
      result: classification.publicContractChanged ? "CHANGED" : "UNCHANGED",
      changedContractPaths: changedPaths.filter((path) => path.startsWith("docs/contracts/")),
    },
    versionDecision,
    decisionRationale: nonRuntimeOnly
      ? "Only documentation, tests, or verification-support files changed after Phase 50 closure; the Agent Runner runtime artifact and externally observable component contract are unchanged."
      : "Runtime-affecting or externally observable component-contract paths changed after Phase 50 closure; the current component version must not be silently reused.",
    sameAsMilestoneVersion: componentVersion === SYSTEM_MILESTONE_VERSION,
    sameVersionIndependentRationale:
      componentVersion === SYSTEM_MILESTONE_VERSION
        ? null
        : "not-required: component version differs from the v0.4.0 system milestone",
    changeClassification: nonRuntimeOnly ? "verification-support-only" : "runtime-or-contract-change",
    changedPaths,
    realInfrastructureDecision: {
      artifactContractChanged: classification.artifactContractChanged,
      s3SdkOrPersistenceChanged: classification.s3SdkOrPersistenceChanged,
      iamBoundaryChanged: classification.iamBoundaryChanged,
      encryptionChanged: classification.encryptionChanged,
      lifecycleChanged: classification.lifecycleChanged,
      changeTriggeredRealS3: realInfrastructureRequired
        ? {
            result: "REQUIRED_PENDING_EXECUTION",
            decisionRationale:
              "At least one Phase 50 real-infrastructure trigger changed after Phase 50 closure; change-triggered real private S3 verification is required before RC PASS.",
            rawEvidenceReference: null,
          }
        : {
            result: "NOT_REQUIRED_WITH_REASON",
            decisionRationale:
              "No artifact contract, S3 SDK/persistence, IAM boundary, encryption, or lifecycle trigger changed after Phase 50 closure; Phase 51 changes are verification support/documentation only.",
            rawEvidenceReference: null,
          },
      systemReleaseMandatory: {
        realS3: true,
        environmentConformance: true,
      },
    },
  };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invoked) {
  try {
    const options = parseCli(process.argv.slice(2));
    const root = options.get("root") || scriptRoot(import.meta.url);
    const sourceRevision = requiredOption(options, "source-revision");
    writeJsonStdout(classifyAgentRunnerRcChange({ root, sourceRevision }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
