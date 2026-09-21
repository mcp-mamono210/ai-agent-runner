import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { S3Client } from "@aws-sdk/client-s3";

import { AwsSdkPhase49S3ObjectClient } from "../../src/artifact/aws-s3-client.js";
import { assertPhase50EnvironmentCoverageClosed } from "../../src/verification/phase50-conformance.js";
import { runPhase50S3Conformance } from "../../src/verification/phase50-s3-conformance.js";

const bucket = process.env.PHASE50_S3_CONFORMANCE_BUCKET?.trim();
const region = process.env.PHASE50_S3_CONFORMANCE_REGION?.trim();
const executionId = process.env.PHASE50_S3_CONFORMANCE_EXECUTION_ID?.trim();
const enabled = bucket !== undefined && bucket !== "" && region !== undefined && region !== "" && executionId !== undefined && executionId !== "";

void describe("Phase 50-2 S3 environment conformance", () => {
  void it(
    "measures conditional write, checksum, metadata round-trip, Head/Get, and SSE semantics",
    { skip: enabled ? false : "configure PHASE50_S3_CONFORMANCE_BUCKET / REGION / EXECUTION_ID" },
    async () => {
      assert.ok(bucket !== undefined);
      assert.ok(region !== undefined);
      assert.ok(executionId !== undefined);
      const endpoint = process.env.PHASE50_S3_CONFORMANCE_ENDPOINT?.trim();
      const client = new AwsSdkPhase49S3ObjectClient({
        config: { region },
        client: new S3Client({
          region,
          ...(endpoint === undefined || endpoint === ""
            ? {}
            : { endpoint, forcePathStyle: true }),
        }),
      });
      const findings = await runPhase50S3Conformance({
        client,
        config: {
          region,
          bucket,
          prefix: process.env.PHASE50_S3_CONFORMANCE_PREFIX?.trim() || "phase50/conformance",
        },
        executionId,
        issueId: 5426,
        repository: "mcp-mamono210/ai-agent-runner",
        sourceRevision: await resolveTestedGitRevision(),
      });

      assert.equal(findings.length >= 7, true);
      assert.doesNotThrow(() => assertPhase50EnvironmentCoverageClosed(findings));
    },
  );
});

async function resolveTestedGitRevision(): Promise<string> {
  const configured = process.env.PHASE50_TESTED_GIT_REVISION?.trim();
  if (configured !== undefined && configured !== "") {
    return validateGitRevision(configured, "PHASE50_TESTED_GIT_REVISION");
  }

  const detected = await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile("git", ["rev-parse", "HEAD"], { encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        rejectPromise(new Error("failed to detect current Git revision", { cause: error }));
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
  return validateGitRevision(detected, "git rev-parse HEAD");
}

function validateGitRevision(value: string, source: string): string {
  if (!/^[0-9a-f]{40,64}$/u.test(value)) {
    throw new Error(`${source} must resolve to a lowercase full Git revision`);
  }
  return value;
}
