import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { S3Client } from "@aws-sdk/client-s3";

import { AwsSdkPhase49S3ObjectClient } from "../../src/artifact/aws-s3-client.js";
import { buildPhase49Artifact } from "../../src/artifact/contract.js";
import { Phase49S3ArtifactPersistence } from "../../src/artifact/s3-persistence.js";

const endpoint = process.env.PHASE49_S3_COMPAT_ENDPOINT?.trim();
const enabled = endpoint !== undefined && endpoint !== "";

void describe("Phase 49-5 S3-compatible integration", () => {
  void it(
    "verifies conditional PutObject, lowercase metadata, checksum-enabled Head/Get, and deterministic recovery",
    { skip: enabled ? false : "PHASE49_S3_COMPAT_ENDPOINT is not configured" },
    async () => {
      const region = requiredEnv("PHASE49_S3_COMPAT_REGION");
      const bucket = requiredEnv("PHASE49_S3_COMPAT_BUCKET");
      const executionId = randomUUID();
      const config = {
        region,
        bucket,
        prefix: `phase49/compat/${executionId}`,
      };
      const client = new AwsSdkPhase49S3ObjectClient({
        config,
        client: new S3Client({
          region,
          endpoint,
          forcePathStyle: true,
        }),
      });
      const persistence = new Phase49S3ArtifactPersistence({ client, config });
      const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
      const artifact = buildPhase49Artifact({
        executionId,
        issueId: 5422,
        repository: "mcp-mamono210/ai-agent-runner",
        sourceRevision: "a".repeat(40),
        briefRevision: 11,
        persistedRevision: "phase49-s3-compatible",
        requirementsFingerprint: `sha256:${"b".repeat(64)}`,
        outcome: "changes_ready",
        changedFiles: [{ path: "a.txt", status: "modified" }],
        patch: {
          text: patch,
          capturedBytes: Buffer.byteLength(patch, "utf8"),
          truncated: false,
        },
      });

      const persisted = await persistence.persistAndConfirm(artifact);
      const document = await persistence.getAndVerify(persisted.artifactReference, artifact);
      const recovered = await persistence.recoverAndVerify({
        executionId: artifact.manifest.executionId,
        issueId: artifact.manifest.issueId,
        repository: artifact.manifest.repository,
        sourceRevision: artifact.manifest.sourceRevision,
        briefRevision: artifact.manifest.briefRevision,
        persistedRevision: artifact.manifest.persistedRevision,
        requirementsFingerprint: artifact.manifest.requirementsFingerprint,
      });

      assert.equal(document.manifest.executionId, executionId);
      assert.equal(recovered.artifact.envelopeChecksumSha256Hex, artifact.envelopeChecksumSha256Hex);
      assert.equal(recovered.persisted.artifactReference, persisted.artifactReference);
    },
  );
});

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required when PHASE49_S3_COMPAT_ENDPOINT is configured`);
  }
  return value;
}
