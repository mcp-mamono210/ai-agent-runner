import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { S3Client } from "@aws-sdk/client-s3";

import { AwsSdkPhase49S3ObjectClient } from "../artifact/aws-s3-client.js";
import {
  assertPhase50EnvironmentCoverageClosed,
  type Phase50ConformanceFinding,
  type Phase50EnvironmentConformanceRecord,
} from "./phase50-conformance.js";
import { runPhase50S3Conformance } from "./phase50-s3-conformance.js";
import { runPhase50SandboxConformance } from "./phase50-sandbox-conformance.js";

export async function runPhase50EnvironmentConformanceFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Phase50EnvironmentConformanceRecord> {
  const testedGitRevision = await resolveTestedGitRevision(env.PHASE50_TESTED_GIT_REVISION);
  const sandbox = await runPhase50SandboxConformance({
    configuredNetworkName: optionalText(env.AGENT_RUNNER_SANDBOX_NETWORK_NAME),
    configuredProxyContainerName: optionalText(env.AGENT_RUNNER_SANDBOX_PROXY_CONTAINER),
    configuredPolicyDigest: optionalText(env.PHASE50_SANDBOX_POLICY_DIGEST),
    configuredProxyUrl: optionalText(env.AGENT_RUNNER_SANDBOX_PROXY_URL),
    allowedProbeUrl: optionalText(env.PHASE50_SANDBOX_ALLOWED_PROBE_URL),
    deniedProbeUrl: optionalText(env.PHASE50_SANDBOX_DENIED_PROBE_URL),
    networkProbeImage: optionalText(env.PHASE50_SANDBOX_PROBE_IMAGE),
  });

  const findings: Phase50ConformanceFinding[] = [...sandbox.findings];
  const bucket = optionalText(env.PHASE50_S3_CONFORMANCE_BUCKET);
  const region = optionalText(env.PHASE50_S3_CONFORMANCE_REGION);
  const executionId = optionalText(env.PHASE50_S3_CONFORMANCE_EXECUTION_ID);

  if (bucket === undefined || region === undefined || executionId === undefined) {
    findings.push(Object.freeze({
      id: "s3.environment",
      surface: "s3",
      requirement: "S3-compatible or real S3 conformance probe is executed with an isolated test object",
      classification: "unsupported",
      evidence: Object.freeze([
        "PHASE50_S3_CONFORMANCE_BUCKET / REGION / EXECUTION_ID are not fully configured",
      ]),
      coverageRoute: "C",
      coverageExecuted: false,
      coverageEvidence: Object.freeze([
        "execute the probe against the chosen real/prod-compatible S3 environment before closing Phase 50-2",
      ]),
    }));
  } else {
    const endpoint = optionalText(env.PHASE50_S3_CONFORMANCE_ENDPOINT);
    const forcePathStyle = endpoint !== undefined;
    const s3 = new S3Client({
      region,
      ...(endpoint === undefined ? {} : { endpoint, forcePathStyle }),
    });
    const client = new AwsSdkPhase49S3ObjectClient({ config: { region }, client: s3 });
    findings.push(...await runPhase50S3Conformance({
      client,
      config: {
        region,
        bucket,
        prefix: optionalText(env.PHASE50_S3_CONFORMANCE_PREFIX) ?? "phase50/conformance",
        ...(optionalText(env.AGENT_RUNNER_ARTIFACT_S3_EXPECTED_BUCKET_OWNER) === undefined
          ? {}
          : { expectedBucketOwner: optionalText(env.AGENT_RUNNER_ARTIFACT_S3_EXPECTED_BUCKET_OWNER) }),
      },
      executionId,
      issueId: 5426,
      repository: "mcp-mamono210/ai-agent-runner",
      sourceRevision: testedGitRevision,
    }));
  }

  const record: Phase50EnvironmentConformanceRecord = Object.freeze({
    schemaVersion: 1,
    testedGitRevision,
    generatedAt: new Date().toISOString(),
    findings: Object.freeze(findings),
  });

  const recordPath = optionalText(env.PHASE50_ENVIRONMENT_CONFORMANCE_RECORD)
    ?? "docs/verification/phase50-environment-conformance.json";
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "w" });
  assertPhase50EnvironmentCoverageClosed(record.findings);
  return record;
}

async function resolveTestedGitRevision(raw: string | undefined): Promise<string> {
  const configured = optionalText(raw);
  if (configured !== undefined) {
    return validateGitRevision(configured, "PHASE50_TESTED_GIT_REVISION");
  }
  const detected = await currentGitRevision();
  return validateGitRevision(detected, "git rev-parse HEAD");
}

function validateGitRevision(value: string, source: string): string {
  if (!/^[0-9a-f]{40,64}$/u.test(value)) {
    throw new Error(`${source} must resolve to a lowercase full Git revision`);
  }
  return value;
}

async function currentGitRevision(): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["rev-parse", "HEAD"],
      { encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(new Error("failed to detect current Git revision", { cause: error }));
          return;
        }
        resolvePromise(stdout.trim());
      },
    );
  });
}

function optionalText(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value === undefined || value === "" ? undefined : value;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const record = await runPhase50EnvironmentConformanceFromEnvironment();
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}
