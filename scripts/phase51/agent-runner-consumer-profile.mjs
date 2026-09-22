import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  fail,
  parseCli,
  readJson,
  requiredOption,
  scriptRoot,
  writeJsonStdout,
} from "./common.mjs";

const FIELD_KEYS = [
  "lifecycle",
  "approvedBy",
  "approvedAt",
  "approvedBriefRevision",
  "approvedPersistedRevision",
  "approvedRequirementsFingerprint",
];

const EXPECTED_CONSTRAINT_IDS = Object.freeze({
  approvedBy: "redmine-principal-v1",
  approvedAt: "rfc3339-offset-timestamp-v1",
  approvedBriefRevision: "positive-safe-base10-integer-v1",
  approvedPersistedRevision: "nonblank-opaque-string-v1",
  approvedRequirementsFingerprint: "sha256-lowercase-hex-v1",
});

function extractFieldNames(source) {
  const block = /const FIELD_NAMES = \{([\s\S]*?)\} as const;/u.exec(source)?.[1];
  if (block === undefined) {
    fail("production FIELD_NAMES block was not found");
  }
  const fields = {};
  for (const key of FIELD_KEYS) {
    const match = new RegExp(`${key}:\\s*"([^"]+)"`, "u").exec(block);
    if (match === null) {
      fail(`production FIELD_NAMES.${key} was not found`);
    }
    fields[key] = match[1];
  }
  return fields;
}

function assertProductionValidationShape(source, canonical, fields) {
  if (!source.includes('lifecycle !== "Ready for Agent"')) {
    fail("production handoff validator no longer checks Ready for Agent exactly");
  }
  if (!source.includes("/^redmine-user:[1-9]\\d*$/u")) {
    fail("production approver validation pattern drifted");
  }
  if (!source.includes("/^sha256:[0-9a-f]{64}$/u")) {
    fail("production requirements fingerprint validation pattern drifted");
  }
  if (!source.includes("Number.isSafeInteger(briefRevision)")) {
    fail("production Brief revision safe-integer guard is missing");
  }
  if (!source.includes('persistedRevision.trim() === ""')) {
    fail("production persisted revision nonblank guard is missing");
  }
  if (!source.includes("Date.parse(approvedAt)")) {
    fail("production approved_at timestamp validation is missing");
  }

  if (canonical.lifecycle?.fieldName !== fields.lifecycle) {
    fail("canonical lifecycle field name differs from production binding");
  }
  if (canonical.lifecycle?.readyForAgentValue !== "Ready for Agent") {
    fail("canonical Ready for Agent value differs from production validator");
  }

  for (const [key, constraintId] of Object.entries(EXPECTED_CONSTRAINT_IDS)) {
    if (canonical.approval?.[key]?.fieldName !== fields[key]) {
      fail(`canonical approval field name differs from production binding: ${key}`);
    }
    if (canonical.approval?.[key]?.constraint?.constraintId !== constraintId) {
      fail(`canonical constraintId differs from production semantic binding: ${key}`);
    }
  }
}

export function deriveConsumerProfile({ root, canonicalProfilePath }) {
  const sourcePath = resolve(root, "src/agent-brief/handoff-binding.ts");
  const source = readFileSync(sourcePath, "utf8");
  const canonical = readJson(canonicalProfilePath);
  const fields = extractFieldNames(source);
  assertProductionValidationShape(source, canonical, fields);

  return {
    schemaVersion: canonical.schemaVersion,
    profileId: canonical.profileId,
    lifecycle: {
      fieldName: fields.lifecycle,
      readyForAgentValue: "Ready for Agent",
    },
    approval: Object.fromEntries(
      Object.entries(canonical.approval).map(([key, value]) => [
        key,
        { ...value, fieldName: fields[key] },
      ]),
    ),
    customFieldSemantics: structuredClone(canonical.customFieldSemantics),
    handoffIdentity: structuredClone(canonical.handoffIdentity),
    requirementsFingerprint: structuredClone(canonical.requirementsFingerprint),
    constraints: structuredClone(canonical.constraints),
    contractReferences: structuredClone(canonical.contractReferences),
  };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invoked) {
  try {
    const options = parseCli(process.argv.slice(2));
    const root = options.get("root") || scriptRoot(import.meta.url);
    const canonicalProfilePath = requiredOption(options, "canonical-profile");
    writeJsonStdout(deriveConsumerProfile({ root, canonicalProfilePath }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
