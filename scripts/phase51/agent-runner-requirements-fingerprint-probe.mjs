import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  importBuilt,
  parseCli,
  requiredOption,
  scriptRoot,
  writeJsonStdout,
} from "./common.mjs";

function readInput(path) {
  return path === "-"
    ? JSON.parse(readFileSync(0, "utf8"))
    : JSON.parse(readFileSync(path, "utf8"));
}

export async function runRequirementsFingerprintProbe({ root, input }) {
  const module = await importBuilt(root, "dist/src/agent-brief/requirements-fingerprint-compat.js");
  const fingerprint = module.calculateAgentBriefRequirementsFingerprintCompat(input);
  return {
    fingerprint,
    productionBinding: {
      module: "src/agent-brief/requirements-fingerprint-compat.ts",
      exportedSymbol: "calculateAgentBriefRequirementsFingerprintCompat",
    },
  };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invoked) {
  try {
    const options = parseCli(process.argv.slice(2));
    const root = options.get("root") || scriptRoot(import.meta.url);
    const inputPath = requiredOption(options, "input");
    writeJsonStdout(await runRequirementsFingerprintProbe({ root, input: readInput(inputPath) }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
