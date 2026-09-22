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

function issueProjection(input) {
  const fields = input.fields;
  const names = [
    ["Agent Brief Lifecycle", fields.lifecycle],
    ["Brief Approved By", fields.approvedBy],
    ["Brief Approved At", fields.approvedAt],
    ["Approved Brief Revision", fields.approvedBriefRevision],
    ["Approved Persisted Revision", fields.approvedPersistedRevision],
    ["Approved Req Fingerprint", fields.approvedRequirementsFingerprint],
  ];

  return {
    issueId: input.issueId,
    projectId: input.projectId,
    raw: {
      id: input.issueId,
      project: { id: input.projectId, name: input.projectName ?? "Phase 51 fixture" },
      customFields: names.map(([name, value], index) => ({
        id: index + 1,
        name,
        value,
      })),
    },
  };
}

export async function runHandoffValidationProbe({ root, input }) {
  const module = await importBuilt(root, "dist/src/agent-brief/handoff-binding.js");
  let capturedReference = null;
  const approvedBriefVerifier = {
    async verify(reference) {
      capturedReference = structuredClone(reference);
      if (input.expectedReference !== undefined) {
        const actual = JSON.stringify(reference);
        const expected = JSON.stringify(input.expectedReference);
        if (actual !== expected) {
          throw new Error("captured approved Brief reference differs from expected fixture");
        }
      }
    },
  };

  const validator = new module.Phase46HandoffValidator({
    repository: input.repository,
    approvedBriefVerifier,
  });
  const validationResult = await validator.validate(issueProjection(input));
  return { validationResult, capturedReference };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invoked) {
  try {
    const options = parseCli(process.argv.slice(2));
    const root = options.get("root") || scriptRoot(import.meta.url);
    const inputPath = requiredOption(options, "input");
    writeJsonStdout(await runHandoffValidationProbe({ root, input: readInput(inputPath) }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
