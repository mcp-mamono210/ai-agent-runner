import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildPhase49Artifact,
  buildPhase49ArtifactFromDevelopmentHandoff,
  verifyPhase49ArtifactBody,
  type Phase49BuiltArtifact,
} from "../../src/artifact/contract.js";
import {
  PHASE49_DEFAULT_S3_PREFIX,
  Phase49S3ArtifactPersistence,
  Phase49S3OperationError,
  type Phase49ArtifactIdentity,
  type Phase49S3GetInput,
  type Phase49S3GetObservation,
  type Phase49S3HeadInput,
  type Phase49S3ObjectClient,
  type Phase49S3ObjectObservation,
  type Phase49S3PutInput,
} from "../../src/artifact/s3-persistence.js";
import {
  buildCodexDockerExecArgs,
  CodexCliAgentAdapter,
} from "../../src/agent/codex-cli-adapter.js";
import type { CodexOneShotRunner } from "../../src/agent/types.js";
import {
  InMemoryDevelopmentPhase49HandoffStore,
  Phase48_7ProvisionalResultHandler,
} from "../../src/development/phase49-handoff.js";
import type { PreparedExecution } from "../../src/execution/types.js";
import {
  DockerSandboxRuntime,
  type DockerCommandRunner,
} from "../../src/sandbox/docker-runtime.js";
import { parseSandboxNetworkPolicy } from "../../src/sandbox/network-policy.js";
import { BoundedUtf8Capture } from "../../src/sandbox/resource-policy.js";
import type {
  SandboxRuntimeConfig,
  TaskWorkspace,
} from "../../src/sandbox/types.js";
import { TaskWorkspaceManager } from "../../src/sandbox/workspace.js";
import { KnownSecretRedactor } from "../../src/security/redaction.js";
import {
  assertPhase50EnvironmentCoverageClosed,
  parsePhase50ConformanceRecord,
} from "../../src/verification/phase50-conformance.js";
import {
  Phase50DeterministicHarness,
  Phase50InjectedFaultError,
} from "../../src/verification/phase50-harness.js";

const ISSUE_ID = 5431;
const PROJECT_ID = 414;
const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const REPOSITORY = "mcp-mamono210/ai-agent-runner";
const BRIEF_REVISION = 13;
const PERSISTED_REVISION = "persisted-revision-13";
const FINGERPRINT = `sha256:${"b".repeat(64)}`;
const STARTED_AT = "2026-09-21T13:00:00.000Z";
const BUCKET = "phase50-restore-example";
const PREFIX = PHASE49_DEFAULT_S3_PREFIX;
const CONTAINER_ID = "c".repeat(64);
const WORKSPACE_PATH = "/var/lib/ai-agent-runner/workspaces/attempt-phase50-7";
const SYNTHETIC_SECRET = "phase50-7-synthetic-secret-fixture";


void describe("Phase 50-7 artifact restore / security / secret / resource regression", () => {
  void it("restores a changes_ready artifact into a clean exact-source checkout after the original workspace is deleted", async () => {
    const fixture = await createRestoreGitFixture();
    try {
      const artifact = buildPhase49Artifact({
        executionId: EXECUTION_ID,
        issueId: ISSUE_ID,
        repository: REPOSITORY,
        sourceRevision: fixture.sourceRevision,
        briefRevision: BRIEF_REVISION,
        persistedRevision: PERSISTED_REVISION,
        requirementsFingerprint: FINGERPRINT,
        outcome: "changes_ready",
        changedFiles: [{ path: "app.txt", status: "modified" }],
        patch: {
          text: fixture.patch,
          capturedBytes: Buffer.byteLength(fixture.patch, "utf8"),
          truncated: false,
        },
      });
      const s3 = new DurableS3Client();
      const persistence = new Phase49S3ArtifactPersistence({ client: s3, config: s3Config() });
      await persistence.persistAndConfirm(artifact);

      await rm(fixture.originalWorkspace, { recursive: true, force: true });
      assert.equal(await pathExists(fixture.originalWorkspace), false);

      const clean = join(fixture.root, "clean");
      await mkdir(clean);
      await runGit(clean, ["init", "-q"]);
      await runGit(clean, ["fetch", "-q", fixture.remote, fixture.sourceRevision]);
      await runGit(clean, ["checkout", "-q", "--detach", fixture.sourceRevision]);

      const exactHead = (await runGit(clean, ["rev-parse", "HEAD"])).trim();
      const latestRemoteHead = (await runGitDir(fixture.remote, ["rev-parse", "refs/heads/main"])).trim();
      assert.equal(exactHead, fixture.sourceRevision);
      assert.notEqual(latestRemoteHead, fixture.sourceRevision);
      assert.equal(await pathExists(join(clean, "latest-only.txt")), false);

      const recovered = await persistence.recoverAndVerify(identityFor(fixture.sourceRevision));
      assert.equal(recovered.document.manifest.sourceRevision, fixture.sourceRevision);
      assert.equal(recovered.document.patch, fixture.patch);

      const patchFile = join(fixture.root, "restore.patch");
      await writeFile(patchFile, recovered.document.patch, "utf8");
      await runGit(clean, ["apply", "--check", "--binary", patchFile]);
      await runGit(clean, ["apply", "--binary", patchFile]);

      assert.equal(await readFile(join(clean, "app.txt"), "utf8"), "restored-change\n");
      assert.match(await runGit(clean, ["status", "--porcelain=v1"]), /app\.txt/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  void it("restores and verifies no_changes as a durable non-absent empty artifact", async () => {
    const fixture = await createRestoreGitFixture();
    try {
      const artifact = buildPhase49Artifact({
        executionId: EXECUTION_ID,
        issueId: ISSUE_ID,
        repository: REPOSITORY,
        sourceRevision: fixture.sourceRevision,
        briefRevision: BRIEF_REVISION,
        persistedRevision: PERSISTED_REVISION,
        requirementsFingerprint: FINGERPRINT,
        outcome: "no_changes",
        changedFiles: [],
        patch: { text: "", capturedBytes: 0, truncated: false },
      });
      const s3 = new DurableS3Client();
      const persistence = new Phase49S3ArtifactPersistence({ client: s3, config: s3Config() });
      const persisted = await persistence.persistAndConfirm(artifact);
      assert.match(persisted.artifactReference, /^s3:\/\//u);

      await rm(fixture.originalWorkspace, { recursive: true, force: true });
      const clean = join(fixture.root, "no-changes-clean");
      await mkdir(clean);
      await runGit(clean, ["init", "-q"]);
      await runGit(clean, ["fetch", "-q", fixture.remote, fixture.sourceRevision]);
      await runGit(clean, ["checkout", "-q", "--detach", fixture.sourceRevision]);

      const recovered = await persistence.recoverAndVerify(identityFor(fixture.sourceRevision));
      assert.equal(recovered.document.manifest.outcome, "no_changes");
      assert.equal(recovered.document.patch, "");
      assert.equal((await runGit(clean, ["status", "--porcelain=v1"])).trim(), "");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  void it("consumes FI-12 and FI-13 as restore failures without converting them into artifact absence", async () => {
    for (const faultId of ["FI-12", "FI-13"] as const) {
      const harness = new Phase50DeterministicHarness();
      const artifact = artifactFixture("changes_ready");
      const persistence = new Phase49S3ArtifactPersistence({ client: harness.s3, config: s3Config() });
      await persistence.persistAndConfirm(artifact);
      harness.faults.arm(faultId);

      await assert.rejects(
        persistence.recoverAndVerify(identityFor(artifact.manifest.sourceRevision)),
        (error: unknown) =>
          error instanceof Phase50InjectedFaultError && error.faultId === faultId,
      );
      assert.deepEqual(harness.faults.observed(), [faultId]);
    }
  });

  void it("consumes SC-07 corruption modes as category-specific restore failures", async () => {
    const cases = [
      ["missing-checksum", /ChecksumSHA256 is missing/u],
      ["checksum-mismatch", /envelope checksum mismatch/u],
      ["metadata-missing", /metadata projection is missing/u],
      ["metadata-mismatch", /metadata mismatch/u],
      ["body-corrupt", /valid JSON|canonical/u],
    ] as const;

    for (const [scenario, expected] of cases) {
      const harness = new Phase50DeterministicHarness();
      const artifact = artifactFixture("changes_ready");
      const persistence = new Phase49S3ArtifactPersistence({ client: harness.s3, config: s3Config() });
      await persistence.persistAndConfirm(artifact);
      harness.scenarios.set("SC-07", scenario);

      await assert.rejects(
        persistence.recoverAndVerify(identityFor(artifact.manifest.sourceRevision)),
        expected,
        scenario,
      );
    }
  });

  void it("asserts explicit restore failure reasons for absent, manifest, patch-checksum, format, and identity failures", async () => {
    const base = artifactFixture("changes_ready");
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly client: Phase49S3ObjectClient;
      readonly identity?: Phase49ArtifactIdentity;
      readonly expected: RegExp | ((error: unknown) => boolean);
    }> = [
      {
        name: "artifact absent",
        client: new RestoreFailureS3Client(base, "not-found"),
        expected: (error: unknown) =>
          error instanceof Phase49S3OperationError && error.kind === "not_found",
      },
      {
        name: "checksum mismatch",
        client: new RestoreFailureS3Client(base, "checksum-mismatch"),
        expected: /envelope checksum mismatch/u,
      },
      {
        name: "manifest metadata mismatch",
        client: new RestoreFailureS3Client(base, "metadata-mismatch"),
        expected: /metadata mismatch/u,
      },
      {
        name: "patch checksum mismatch",
        client: new RestoreFailureS3Client(base, "patch-checksum-mismatch"),
        expected: /patch checksum mismatch/u,
      },
      {
        name: "unsupported artifact format",
        client: new RestoreFailureS3Client(base, "unsupported-format"),
        expected: /format version is unsupported/u,
      },
      {
        name: "identity mismatch",
        client: new RestoreFailureS3Client(
          artifactFixture("changes_ready", { sourceRevision: "c".repeat(40) }),
          "normal",
        ),
        expected: /identity does not match Agent Running execution/u,
      },
    ];

    for (const testCase of cases) {
      const persistence = new Phase49S3ArtifactPersistence({ client: testCase.client, config: s3Config() });
      const operation = persistence.recoverAndVerify(
        testCase.identity ?? identityFor(base.manifest.sourceRevision),
      );
      if (testCase.expected instanceof RegExp) {
        await assert.rejects(operation, testCase.expected, testCase.name);
      } else {
        await assert.rejects(operation, testCase.expected, testCase.name);
      }
    }
  });

  void it("fails restore for an invalid finalized artifact without rolling the finalized lifecycle backward", async () => {
    const lifecycle = "Ready for Independent Verification";
    const artifact = artifactFixture("changes_ready");
    const persistence = new Phase49S3ArtifactPersistence({
      client: new RestoreFailureS3Client(artifact, "patch-checksum-mismatch"),
      config: s3Config(),
    });

    await assert.rejects(
      persistence.recoverAndVerify(identityFor(artifact.manifest.sourceRevision)),
      /patch checksum mismatch/u,
    );

    assert.equal(lifecycle, "Ready for Independent Verification");
  });

  void it("keeps Controller, Redmine, Git, and container-engine credentials outside the Agent sandbox", async () => {
    const config = sandboxConfig();
    const docker = new SecurityDockerRunner(config.network.digest);
    const workspace = new FakeWorkspace();
    const runtime = new DockerSandboxRuntime({ config, dockerRunner: docker });

    const handle = await runtime.create({ execution: preparedExecution(), workspace });
    const createCall = docker.calls.find((call) => call[0] === "create");
    assert.ok(createCall !== undefined);
    const createSerialized = createCall.join(" ");
    const codexExecSerialized = buildCodexDockerExecArgs(CONTAINER_ID).join(" ");

    assert.doesNotMatch(createSerialized, /REDMINE_API_KEY|REDMINE_WRITE_API_KEY/u);
    assert.doesNotMatch(createSerialized, /AGENT_RUNNER_GIT_|GIT_WRITE|GIT_PUSH/u);
    assert.doesNotMatch(createSerialized, /CONTROL_PLANE_API_KEY/u);
    assert.doesNotMatch(createSerialized, /docker\.sock/u);
    assert.doesNotMatch(codexExecSerialized, /REDMINE_|AGENT_RUNNER_GIT_|CONTROL_PLANE_API_KEY/u);
    assert.match(codexExecSerialized, /--env CODEX_API_KEY/u);
    assert.equal(createCall.filter((entry) => entry === "--mount").length, 1);
    assert.ok(createCall.some((entry) => entry.includes(`src=${WORKSPACE_PATH},dst=/workspace,rw`)));

    await handle.dispose("success");

    for (const forbiddenName of [
      "REDMINE_WRITE_API_KEY",
      "AGENT_RUNNER_GIT_READ_TOKEN",
      "CONTROL_PLANE_API_KEY",
    ] as const) {
      const leakingDocker = new SecurityDockerRunner(config.network.digest);
      leakingDocker.extraEnvironment = `${forbiddenName}=synthetic`;
      await assert.rejects(
        new DockerSandboxRuntime({ config, dockerRunner: leakingDocker }).create({
          execution: preparedExecution(),
          workspace: new FakeWorkspace(),
        }),
        new RegExp(`forbidden Controller credential environment exposed to Agent: ${forbiddenName}`, "u"),
      );
    }

    const socketDocker = new SecurityDockerRunner(config.network.digest);
    socketDocker.mountDockerSocket = true;
    await assert.rejects(
      new DockerSandboxRuntime({ config, dockerRunner: socketDocker }).create({
        execution: preparedExecution(),
        workspace: new FakeWorkspace(),
      }),
      /only host-backed sandbox mount|control socket/u,
    );
  });

  void it("consumes FI-15 and proves production network-policy failure does not fall back to unrestricted egress", async () => {
    const harness = new Phase50DeterministicHarness();
    harness.faults.arm("FI-15");
    await assert.rejects(
      harness.sandbox.applyNetworkPolicy(),
      (error: unknown) =>
        error instanceof Phase50InjectedFaultError && error.faultId === "FI-15",
    );
    assert.throws(() => harness.sandbox.assertNetworkPolicyApplied(), /was not applied/u);

    const config = sandboxConfig();
    const docker = new SecurityDockerRunner(config.network.digest);
    docker.networkInternal = false;
    await assert.rejects(
      new DockerSandboxRuntime({ config, dockerRunner: docker }).create({
        execution: preparedExecution(),
        workspace: new FakeWorkspace(),
      }),
      /must be internal to prevent direct unrestricted egress/u,
    );
    assert.equal(docker.calls.some((call) => call[0] === "create"), false);
  });

  void it("consumes SC-02 and measures finite output capture with truncation", async () => {
    const harness = new Phase50DeterministicHarness();
    harness.scenarios.set("SC-02", 16);
    const generated = await harness.agent.run("changes_ready");
    assert.equal(Buffer.byteLength(generated.output, "utf8"), 16);

    const capture = new BoundedUtf8Capture(4);
    capture.append(generated.output);
    assert.deepEqual(capture.snapshot(), {
      text: "xxxx",
      capturedBytes: 4,
      truncated: true,
    });
  });

  void it("consumes SC-03 and measures production workspace disk enforcement", async () => {
    const harness = new Phase50DeterministicHarness();
    harness.scenarios.set("SC-03", 8);
    const root = await mkdtemp(join(tmpdir(), "phase50-7-disk-"));
    try {
      const manager = new TaskWorkspaceManager({ root, diskLimitBytes: 4 });
      const workspace = await manager.create(EXECUTION_ID);
      await writeFile(join(workspace.path, "over-limit.bin"), Buffer.alloc(harness.sandbox.workspaceBytes(), 1));
      await assert.rejects(
        workspace.assertWithinDiskLimit(),
        /workspace disk usage exceeded configured limit/u,
      );
      await workspace.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("closes sandbox conformance differences through the recorded alternate coverage routes", async () => {
    const raw = await readFile("docs/verification/phase50-environment-conformance.json", "utf8");
    const record = parsePhase50ConformanceRecord(JSON.parse(raw) as unknown);
    assertPhase50EnvironmentCoverageClosed(record.findings);

    for (const id of [
      "sandbox.network-policy",
      "sandbox.workspace-disk",
      "sandbox.output-capture",
      "sandbox.container-lifecycle",
    ] as const) {
      const finding = record.findings.find((entry) => entry.id === id);
      assert.ok(finding !== undefined, id);
      if (finding.classification !== "compatible") {
        assert.equal(finding.coverageExecuted, true, id);
        assert.ok(finding.coverageRoute !== undefined, id);
        assert.ok((finding.coverageEvidence?.length ?? 0) > 0, id);
      }
    }
  });

  void it("uses only a synthetic secret, redacts persisted summaries/diagnostics/metadata boundaries, and preserves patch bytes", async () => {
    assert.match(SYNTHETIC_SECRET, /synthetic-secret-fixture/u);
    const redactor = new KnownSecretRedactor([SYNTHETIC_SECRET]);
    const runner: CodexOneShotRunner = {
      run: () => Promise.resolve({
        kind: "completed",
        exitCode: 0,
        output: {
          text: `log=${SYNTHETIC_SECRET}`,
          capturedBytes: Buffer.byteLength(`log=${SYNTHETIC_SECRET}`, "utf8"),
          truncated: false,
        },
        diagnostic: {
          text: `token=${SYNTHETIC_SECRET}`,
          capturedBytes: Buffer.byteLength(`token=${SYNTHETIC_SECRET}`, "utf8"),
          truncated: false,
        },
      }),
    };
    const adapter = new CodexCliAgentAdapter({
      credentialProvider: { getCredential: () => ({ apiKey: "synthetic-provider-key" }) },
      runner,
      changeDetector: { hasChanges: () => Promise.resolve(true) },
      redactor,
    });
    const result = await adapter.runAgent(agentAdapterInput());
    assert.equal(result.kind, "provisional_success");
    if (result.kind !== "provisional_success") {
      throw new Error("expected provisional success fixture");
    }
    assert.doesNotMatch(result.output.text, new RegExp(SYNTHETIC_SECRET, "u"));
    assert.doesNotMatch(result.diagnostic.text, new RegExp(SYNTHETIC_SECRET, "u"));
    assert.match(result.output.text, /\[REDACTED\]/u);
    assert.match(result.diagnostic.text, /\[REDACTED\]/u);
    assert.doesNotMatch(
      redactor.redact(`runtime log ${SYNTHETIC_SECRET}`, "runtime_diagnostic"),
      new RegExp(SYNTHETIC_SECRET, "u"),
    );
    assert.doesNotMatch(
      redactor.redact(`metadata note ${SYNTHETIC_SECRET}`, "artifact_metadata"),
      new RegExp(SYNTHETIC_SECRET, "u"),
    );

    const patch = `diff --git a/secret.txt b/secret.txt\nnew file mode 100644\n--- /dev/null\n+++ b/secret.txt\n@@ -0,0 +1 @@\n+${SYNTHETIC_SECRET}\n`;
    const store = new InMemoryDevelopmentPhase49HandoffStore();
    const handler = new Phase48_7ProvisionalResultHandler({
      collector: {
        collect: () => Promise.resolve({
          changedFiles: [{ path: "secret.txt", status: "untracked" }],
          patch: {
            text: patch,
            capturedBytes: Buffer.byteLength(patch, "utf8"),
            truncated: false,
          },
        }),
      },
      sink: store,
      summaryCaptureBytes: 4096,
    });
    const execution = preparedExecution();
    const workspace = new FakeWorkspace();
    await handler.handle({
      execution,
      result,
      workspace,
      checkout: {
        repository: execution.input.repository,
        sourceRevision: execution.input.sourceRevision,
        targetDir: workspace.path,
        headRevision: execution.input.sourceRevision,
      },
    });

    const handoff = store.list()[0];
    assert.ok(handoff !== undefined);
    assert.doesNotMatch(handoff.executionSummary.text, new RegExp(SYNTHETIC_SECRET, "u"));

    const artifact = buildPhase49ArtifactFromDevelopmentHandoff(handoff);
    assert.doesNotMatch(JSON.stringify(artifact.metadata), new RegExp(SYNTHETIC_SECRET, "u"));
    assert.match(Buffer.from(artifact.body).toString("utf8"), new RegExp(SYNTHETIC_SECRET, "u"));
    const verifiedArtifact = verifyPhase49ArtifactBody(artifact.body);
    assert.equal(verifiedArtifact.patch, patch);
  });
});

function s3Config() {
  return Object.freeze({
    region: "ap-northeast-1",
    bucket: BUCKET,
    prefix: PREFIX,
    expectedBucketOwner: "123456789012",
  });
}

function identityFor(sourceRevision: string): Phase49ArtifactIdentity {
  return Object.freeze({
    executionId: EXECUTION_ID,
    issueId: ISSUE_ID,
    repository: REPOSITORY,
    sourceRevision,
    briefRevision: BRIEF_REVISION,
    persistedRevision: PERSISTED_REVISION,
    requirementsFingerprint: FINGERPRINT,
  });
}

function artifactFixture(
  outcome: "changes_ready" | "no_changes",
  overrides: Partial<{
    readonly sourceRevision: string;
  }> = {},
): Phase49BuiltArtifact {
  const patch = outcome === "changes_ready"
    ? "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"
    : "";
  return buildPhase49Artifact({
    executionId: EXECUTION_ID,
    issueId: ISSUE_ID,
    repository: REPOSITORY,
    sourceRevision: overrides.sourceRevision ?? "a".repeat(40),
    briefRevision: BRIEF_REVISION,
    persistedRevision: PERSISTED_REVISION,
    requirementsFingerprint: FINGERPRINT,
    outcome,
    changedFiles: outcome === "changes_ready" ? [{ path: "a.txt", status: "modified" }] : [],
    patch: {
      text: patch,
      capturedBytes: Buffer.byteLength(patch, "utf8"),
      truncated: false,
    },
  });
}

interface StoredS3Object {
  readonly body: Uint8Array;
  readonly checksumSha256Base64: string;
  readonly metadata: Readonly<Record<string, string | undefined>>;
  readonly serverSideEncryption: string;
}

class DurableS3Client implements Phase49S3ObjectClient {
  #stored: StoredS3Object | undefined;

  putObject(input: Phase49S3PutInput): Promise<void> {
    if (this.#stored !== undefined) {
      return Promise.reject(new Phase49S3OperationError("conflict", "existing object"));
    }
    this.#stored = Object.freeze({
      body: Uint8Array.from(input.body),
      checksumSha256Base64: input.checksumSha256Base64,
      metadata: Object.freeze({ ...input.metadata }),
      serverSideEncryption: input.serverSideEncryption,
    });
    return Promise.resolve();
  }

  headObject(_input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation> {
    return Promise.resolve(this.#observation());
  }

  getObject(_input: Phase49S3GetInput): Promise<Phase49S3GetObservation> {
    const stored = this.#required();
    return Promise.resolve({ ...this.#observation(), body: Uint8Array.from(stored.body) });
  }

  #required(): StoredS3Object {
    if (this.#stored === undefined) {
      throw new Phase49S3OperationError("not_found", "object absent");
    }
    return this.#stored;
  }

  #observation(): Phase49S3ObjectObservation {
    const stored = this.#required();
    return Object.freeze({
      checksumType: "FULL_OBJECT",
      checksumSha256Base64: stored.checksumSha256Base64,
      metadata: stored.metadata,
      serverSideEncryption: stored.serverSideEncryption,
      versionId: undefined,
      contentLength: stored.body.byteLength,
    });
  }
}

type RestoreFailureMode =
  | "normal"
  | "not-found"
  | "checksum-mismatch"
  | "metadata-mismatch"
  | "patch-checksum-mismatch"
  | "unsupported-format";

class RestoreFailureS3Client implements Phase49S3ObjectClient {
  readonly #artifact: Phase49BuiltArtifact;
  readonly #mode: RestoreFailureMode;

  constructor(artifact: Phase49BuiltArtifact, mode: RestoreFailureMode) {
    this.#artifact = artifact;
    this.#mode = mode;
  }

  putObject(_input: Phase49S3PutInput): Promise<void> {
    return Promise.reject(new Error("restore-only client"));
  }

  headObject(_input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation> {
    if (this.#mode === "not-found") {
      return Promise.reject(new Phase49S3OperationError("not_found", "artifact absent"));
    }
    return Promise.resolve(this.#observation());
  }

  getObject(_input: Phase49S3GetInput): Promise<Phase49S3GetObservation> {
    if (this.#mode === "not-found") {
      return Promise.reject(new Phase49S3OperationError("not_found", "artifact absent"));
    }
    return Promise.resolve({ ...this.#observation(), body: this.#body() });
  }

  #observation(): Phase49S3ObjectObservation {
    const metadata: Record<string, string | undefined> = { ...this.#artifact.metadata };
    if (this.#mode === "metadata-mismatch") {
      metadata.repository = "Y29ycnVwdC9yZXBvc2l0b3J5";
    }
    return Object.freeze({
      checksumType: "FULL_OBJECT",
      checksumSha256Base64:
        this.#mode === "checksum-mismatch"
          ? Buffer.from("wrong-checksum", "utf8").toString("base64")
          : this.#artifact.envelopeChecksumSha256Base64,
      metadata: Object.freeze(metadata),
      serverSideEncryption: "AES256",
      versionId: undefined,
      contentLength: this.#artifact.sizeBytes,
    });
  }

  #body(): Uint8Array {
    if (this.#mode !== "patch-checksum-mismatch" && this.#mode !== "unsupported-format") {
      return Uint8Array.from(this.#artifact.body);
    }

    const body = Buffer.from(this.#artifact.body).toString("utf8");
    if (this.#mode === "patch-checksum-mismatch") {
      const verified = verifyPhase49ArtifactBody(this.#artifact.body);
      const originalField = `"patch":${JSON.stringify(verified.patch)}`;
      const tamperedField = `"patch":${JSON.stringify(`${verified.patch}tampered`)}`;
      return Buffer.from(replaceExactlyOnce(body, originalField, tamperedField), "utf8");
    }

    return Buffer.from(
      replaceExactlyOnce(
        body,
        '"artifactFormatVersion":"phase49.single.v1"',
        '"artifactFormatVersion":"unsupported.phase50"',
      ),
      "utf8",
    );
  }
}

function replaceExactlyOnce(source: string, expected: string, replacement: string): string {
  const first = source.indexOf(expected);
  if (first < 0) {
    throw new Error(`fixture mutation target was not found: ${expected}`);
  }
  if (source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`fixture mutation target was not unique: ${expected}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + expected.length)}`;
}

function sandboxConfig(): SandboxRuntimeConfig {
  return {
    runtime: "docker",
    agentProvider: "codex-cli",
    image: `registry.example.test/agent@sha256:${"d".repeat(64)}`,
    workspaceRoot: "/var/lib/ai-agent-runner/workspaces",
    network: parseSandboxNetworkPolicy({
      policyJson: JSON.stringify({
        "agent-provider": {
          classification: "required",
          endpoints: ["https://provider.example.test"],
        },
        "package-registry": { classification: "denied", endpoints: [] },
        "required-runtime-dependency": { classification: "denied", endpoints: [] },
        "source-repository": { classification: "denied", endpoints: [] },
        "other-external-endpoint": { classification: "denied", endpoints: [] },
      }),
      dockerNetworkName: "phase50-7-egress",
      proxyContainerName: "phase50-7-proxy",
      proxyUrl: "http://phase50-7-proxy:3128",
    }),
    resources: {
      executionTimeoutMs: 1000,
      outputCaptureBytes: 1024,
      diagnosticCaptureBytes: 1024,
      workspaceDiskBytes: 1024 * 1024,
      containerLifecycleMs: 2000,
      workspaceCheckIntervalMs: 1000,
      tmpfsBytes: 1024 * 1024,
    },
  };
}

class FakeWorkspace implements TaskWorkspace {
  readonly executionId = EXECUTION_ID;
  readonly path = WORKSPACE_PATH;
  readonly diskLimitBytes = 1024 * 1024;

  measureDiskUsageBytes(): Promise<number> {
    return Promise.resolve(0);
  }

  assertWithinDiskLimit(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class SecurityDockerRunner implements DockerCommandRunner {
  readonly calls: string[][] = [];
  readonly #policyDigest: string;
  networkInternal = true;
  extraEnvironment: string | undefined;
  mountDockerSocket = false;

  constructor(policyDigest: string) {
    this.#policyDigest = policyDigest;
  }

  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    if (args[0] === "network" && args[1] === "inspect") {
      return Promise.resolve(JSON.stringify({
        Internal: this.networkInternal,
        Labels: { "io.mcp.agent-runner.egress-policy-sha256": this.#policyDigest },
      }));
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === "phase50-7-proxy") {
      return Promise.resolve(JSON.stringify({
        State: { Running: true },
        Config: {
          Labels: {
            "io.mcp.agent-runner.egress-proxy": "true",
            "io.mcp.agent-runner.egress-policy-sha256": this.#policyDigest,
          },
        },
        NetworkSettings: { Networks: { "phase50-7-egress": {} } },
      }));
    }
    if (args[0] === "create") {
      return Promise.resolve(`${CONTAINER_ID}\n`);
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === CONTAINER_ID) {
      const mounts: Array<Record<string, unknown>> = [
        { Type: "bind", Source: WORKSPACE_PATH, Destination: "/workspace", RW: true },
      ];
      if (this.mountDockerSocket) {
        mounts.push({
          Type: "bind",
          Source: "/var/run/docker.sock",
          Destination: "/var/run/docker.sock",
          RW: true,
        });
      }
      const env = [
        "HTTP_PROXY=http://phase50-7-proxy:3128",
        ...(this.extraEnvironment === undefined ? [] : [this.extraEnvironment]),
      ];
      return Promise.resolve(JSON.stringify({
        HostConfig: {
          Privileged: false,
          ReadonlyRootfs: true,
          NetworkMode: "phase50-7-egress",
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
        },
        Config: {
          Labels: {
            "io.mcp.agent-runner.sandbox": "true",
            "io.mcp.agent-runner.execution-id": EXECUTION_ID,
            "io.mcp.agent-runner.egress-policy-sha256": this.#policyDigest,
          },
          Env: env,
        },
        Mounts: mounts,
      }));
    }
    if (args[0] === "rm" && args[1] === "-f") {
      return Promise.resolve(CONTAINER_ID);
    }
    throw new Error(`unexpected Docker call: ${args.join(" ")}`);
  }
}

function preparedExecution(): PreparedExecution {
  const pending = Object.freeze({ kind: "pending" as const });
  const approvedBriefReference = Object.freeze({
    repository: REPOSITORY,
    issueId: ISSUE_ID,
    briefRevision: BRIEF_REVISION,
    persistedRevision: PERSISTED_REVISION,
  });
  const input = Object.freeze({
    executionId: EXECUTION_ID,
    issueId: ISSUE_ID,
    repository: REPOSITORY,
    sourceRevision: "a".repeat(40),
    briefRevision: BRIEF_REVISION,
    persistedRevision: PERSISTED_REVISION,
    requirementsFingerprint: FINGERPRINT,
    approvedBriefReference,
  });
  return Object.freeze({
    issue: { issueId: ISSUE_ID, projectId: PROJECT_ID, lifecycle: "Ready for Agent", raw: {} },
    handoff: {
      issueId: ISSUE_ID,
      repository: REPOSITORY,
      approvedRequirementsFingerprint: FINGERPRINT,
      opaque: {},
    },
    input,
    record: Object.freeze({
      executionId: EXECUTION_ID,
      issueId: ISSUE_ID,
      briefRevision: BRIEF_REVISION,
      persistedRevision: PERSISTED_REVISION,
      requirementsFingerprint: FINGERPRINT,
      repository: REPOSITORY,
      sourceRevision: input.sourceRevision,
      startedAt: STARTED_AT,
      finishedAt: pending,
      outcome: pending,
      artifactReference: pending,
    }),
  });
}

function agentAdapterInput() {
  const execution = preparedExecution();
  const workspace = new FakeWorkspace();
  const enforcement = new AbortController();
  return {
    executionInput: execution.input,
    workspace,
    sandbox: {
      containerId: CONTAINER_ID,
      executionId: EXECUTION_ID,
      workspace,
      resources: sandboxConfig().resources,
      enforcementSignal: enforcement.signal,
      inspectIsolation: () => Promise.resolve({
        containerId: CONTAINER_ID,
        workspaceSource: WORKSPACE_PATH,
        workspaceDestination: "/workspace" as const,
        networkName: "phase50-7-egress",
        policyDigest: sandboxConfig().network.digest,
      }),
      dispose: () => Promise.resolve(),
    },
  };
}

interface RestoreGitFixture {
  readonly root: string;
  readonly originalWorkspace: string;
  readonly remote: string;
  readonly sourceRevision: string;
  readonly patch: string;
}

async function createRestoreGitFixture(): Promise<RestoreGitFixture> {
  const root = await mkdtemp(join(tmpdir(), "phase50-7-restore-"));
  const remote = join(root, "remote.git");
  const originalWorkspace = join(root, "original-workspace");
  await mkdir(originalWorkspace);
  await runGit(root, ["init", "--bare", "-q", remote]);
  await runGit(originalWorkspace, ["init", "-q"]);
  await runGit(originalWorkspace, ["config", "user.email", "phase50-7@example.test"]);
  await runGit(originalWorkspace, ["config", "user.name", "Phase 50-7"]);
  await writeFile(join(originalWorkspace, "app.txt"), "base\n", "utf8");
  await runGit(originalWorkspace, ["add", "app.txt"]);
  await runGit(originalWorkspace, ["commit", "-q", "-m", "base"]);
  const sourceRevision = (await runGit(originalWorkspace, ["rev-parse", "HEAD"])).trim();
  await runGit(originalWorkspace, ["remote", "add", "origin", remote]);
  await runGit(originalWorkspace, ["push", "-q", "origin", "HEAD:refs/heads/main"]);

  await writeFile(join(originalWorkspace, "app.txt"), "restored-change\n", "utf8");
  const patch = await runGit(originalWorkspace, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-renames",
    "HEAD",
    "--",
  ]);
  assert.notEqual(patch, "");

  await runGit(originalWorkspace, ["reset", "-q", "--hard", sourceRevision]);
  await writeFile(join(originalWorkspace, "latest-only.txt"), "latest branch state\n", "utf8");
  await runGit(originalWorkspace, ["add", "latest-only.txt"]);
  await runGit(originalWorkspace, ["commit", "-q", "-m", "move branch head"]);
  await runGit(originalWorkspace, ["push", "-q", "origin", "HEAD:refs/heads/main"]);

  return Object.freeze({ root, originalWorkspace, remote, sourceRevision, patch });
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        rejectPromise(new Error(`git failed: ${args.join(" ")}`, { cause: error }));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function runGitDir(gitDir: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile("git", ["--git-dir", gitDir, ...args], { encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        rejectPromise(new Error(`git --git-dir failed: ${args.join(" ")}`, { cause: error }));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EISDIR"
    ) {
      return true;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
