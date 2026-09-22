import { resolve } from "node:path";

import {
  importBuilt,
  readJson,
  scriptRoot,
  writeJsonStdout,
} from "./common.mjs";

export async function runPhase50BaselineProbe({ root }) {
  const module = await importBuilt(root, "dist/src/verification/phase50-contract-baseline.js");
  const baselinePath = resolve(root, "docs/contracts/phase50-contract-baseline.json");
  const finalRecordPath = resolve(root, "docs/verification/phase50-final-verification-20260921.json");
  const baseline = module.parsePhase50GoldenContract(readJson(baselinePath));
  module.assertPhase50GoldenContractMatches(baseline);
  const finalRecord = readJson(finalRecordPath);
  if (finalRecord.result !== "PASS") {
    throw new Error("Phase 50 final verification record is not PASS");
  }
  return {
    result: "PASS",
    baselinePath: "docs/contracts/phase50-contract-baseline.json",
    finalVerificationPath: "docs/verification/phase50-final-verification-20260921.json",
    phase50TestedRevision: finalRecord.testedGitRevision,
    phase50EvidenceCommitRevision: finalRecord.evidenceCommitRevision,
    environmentConformance: finalRecord.environmentConformance,
  };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invoked) {
  try {
    const rootIndex = process.argv.indexOf("--root");
    const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : scriptRoot(import.meta.url);
    writeJsonStdout(await runPhase50BaselineProbe({ root }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
