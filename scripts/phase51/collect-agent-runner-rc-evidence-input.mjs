import { resolve } from "node:path";

import {
  assertRevisionIsAncestor,
  git,
  gitBlobSha,
  parseCli,
  readJson,
  requireRevision,
  requiredOption,
  scriptRoot,
  writeJsonStdout,
} from "./common.mjs";
import { classifyAgentRunnerRcChange } from "./classify-agent-runner-rc-change.mjs";
import { verifyAgentRunnerRcSupport } from "./verify-agent-runner-rc-support.mjs";

const REPOSITORY = "mcp-mamono210/ai-agent-runner";

function requiredContractIdentities(registryPath) {
  const registry = readJson(registryPath);
  if (!Array.isArray(registry.contracts)) {
    throw new Error("contract registry does not contain contracts[]");
  }
  return registry.contracts
    .filter((entry) => entry.normative === true)
    .map((entry) => {
      if (entry.registrationState !== "committed" || typeof entry.sourceRevision !== "string") {
        throw new Error(`required contract is not release-valid: ${entry.contractId}`);
      }
      return {
        contractId: entry.contractId,
        repository: entry.repository,
        path: entry.path,
        semanticRevision: entry.semanticRevision,
        sourceRevision: entry.sourceRevision,
        sourceBlobSha: entry.sourceBlobSha,
        registrationState: entry.registrationState,
      };
    });
}

export async function collectAgentRunnerRcEvidenceInput({
  root,
  sourceRevision,
  canonicalProfilePath,
  producerVerificationPath,
  contractRegistryPath,
}) {
  requireRevision(root, sourceRevision);
  assertRevisionIsAncestor(root, sourceRevision);
  const head = git(root, ["rev-parse", "HEAD"]);
  if (head !== sourceRevision) {
    throw new Error(
      `collect RC evidence input before later evidence commits: HEAD ${head} != RC source revision ${sourceRevision}`,
    );
  }

  const support = await verifyAgentRunnerRcSupport({
    root,
    canonicalProfilePath,
    producerVerificationPath,
  });
  const classification = classifyAgentRunnerRcChange({ root, sourceRevision });

  if (classification.versionDecision === "NEW_COMPONENT_VERSION_REQUIRED") {
    throw new Error(
      "Agent Runner runtime/public contract changed after Phase 50 closure; decide and commit a new independent component version before freezing RC identity",
    );
  }

  const productionBindings = structuredClone(support.productionBindings);
  for (const binding of Object.values(productionBindings)) {
    binding.sourceRevision = sourceRevision;
    binding.blobSha = gitBlobSha(root, sourceRevision, binding.module);
  }

  return {
    schemaVersion: 1,
    recordType: "agent-runner-phase51-rc-evidence-input",
    componentVersion: classification.componentVersion,
    exactSourceRevision: sourceRevision,
    previousComponentIdentity: classification.previousComponentIdentity,
    runtimeArtifactComparison: classification.runtimeArtifactComparison,
    publicContractComparison: classification.publicContractComparison,
    versionDecision: classification.versionDecision,
    decisionRationale: classification.decisionRationale,
    sameAsMilestoneVersion: classification.sameAsMilestoneVersion,
    sameVersionIndependentRationale: classification.sameVersionIndependentRationale,
    requiredContractIdentities: requiredContractIdentities(contractRegistryPath),
    handoffConsumerProfile: support.handoffConsumerProfile,
    constraintConformance: support.constraintConformance,
    requirementsFingerprintExpectedImplementationSources:
      support.requirementsFingerprintExpectedImplementationSources,
    productionBindings,
    probeBindings: support.probeBindings,
    phase50Baseline: support.phase50Baseline,
    documentationReadiness: support.documentationReadiness,
    realInfrastructureDecision: classification.realInfrastructureDecision,
    canonicalEvidenceOwner: "mcp-mamono210/redmine",
    canonicalEvidencePaths: {
      identity: "docs/verification/phase51-agent-runner-rc-identity.json",
      verification: "docs/verification/phase51-agent-runner-rc-verification.json",
      realInfrastructureDecision:
        "docs/verification/phase51-agent-runner-real-infrastructure-decision.json",
    },
    repository: REPOSITORY,
  };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invoked) {
  try {
    const options = parseCli(process.argv.slice(2));
    const root = options.get("root") || scriptRoot(import.meta.url);
    const sourceRevision = requiredOption(options, "source-revision");
    const canonicalProfilePath = requiredOption(options, "canonical-profile");
    const producerVerificationPath = requiredOption(options, "producer-verification");
    const contractRegistryPath = requiredOption(options, "contract-registry");
    writeJsonStdout(
      await collectAgentRunnerRcEvidenceInput({
        root,
        sourceRevision,
        canonicalProfilePath,
        producerVerificationPath,
        contractRegistryPath,
      }),
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
