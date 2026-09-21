import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildPhase49Artifact,
  verifyPhase49ArtifactBody,
  type Phase49ArtifactBuildInput,
  type Phase49ChangedFile,
  type Phase49ChangedFileStatus,
} from "../../src/artifact/contract.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174001";
const FINGERPRINT = `sha256:${"c".repeat(64)}`;

void describe("Phase 49-1 git patch compatibility", () => {
  void it("packages representative Git edge cases into an artifact whose patch applies to a clean checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "phase49-artifact-git-"));
    try {
      await initializeRepository(root);
      const sourceRevision = (await runGit(root, ["rev-parse", "HEAD"])).trim();
      await createRepresentativeChanges(root);

      const changedFiles = await collectChangedFiles(root);
      const patch = await collectPatch(root, changedFiles);
      const artifact = buildPhase49Artifact(buildInput(sourceRevision, changedFiles, patch));
      const verified = verifyPhase49ArtifactBody(artifact.body, artifact);

      assert.match(verified.patch, /GIT binary patch/u);
      assert.match(verified.patch, /old mode 100644/u);
      assert.match(verified.patch, /new mode 100755/u);
      assert.match(verified.patch, /deleted file mode/u);
      assert.match(verified.patch, /new file mode 120000|index .* 120000/u);
      assert.ok(changedFiles.some((entry) => entry.path === "rename-old.txt" && entry.status === "deleted"));
      assert.ok(changedFiles.some((entry) => entry.path === "rename-new.txt" && entry.status === "added"));
      assert.ok(changedFiles.some((entry) => entry.path === "copy-new.txt" && entry.status === "untracked"));
      assert.ok(changedFiles.some((entry) => entry.path === "untracked.txt" && entry.status === "untracked"));
      assert.ok(changedFiles.some((entry) => entry.path === "empty.txt" && entry.status === "untracked"));

      const clean = join(root, "clean");
      await runGit(root, ["worktree", "add", "--detach", "-q", clean, sourceRevision]);
      const patchFile = join(root, "artifact.patch");
      await writeFile(patchFile, verified.patch, "utf8");

      await assert.doesNotReject(runGit(clean, ["apply", "--check", "--binary", patchFile]));
      await runGit(clean, ["apply", "--binary", patchFile]);

      assert.deepEqual(await readFile(join(clean, "binary.bin")), Buffer.from([0, 1, 2, 3, 255, 254, 253]));
      assert.equal(await readFile(join(clean, "untracked.txt"), "utf8"), "untracked\n");
      assert.equal((await readFile(join(clean, "empty.txt"))).byteLength, 0);
      assert.equal(await readFile(join(clean, "rename-new.txt"), "utf8"), "rename me\n");
      assert.equal(await readFile(join(clean, "copy-new.txt"), "utf8"), "copy source\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function buildInput(
  sourceRevision: string,
  changedFiles: readonly Phase49ChangedFile[],
  patch: string,
): Phase49ArtifactBuildInput {
  return {
    executionId: EXECUTION_ID,
    issueId: 5418,
    repository: "mcp-mamono210/ai-agent-runner",
    sourceRevision,
    briefRevision: 1,
    persistedRevision: "phase49-1-test",
    requirementsFingerprint: FINGERPRINT,
    outcome: "changes_ready",
    changedFiles,
    patch: {
      text: patch,
      capturedBytes: Buffer.byteLength(patch, "utf8"),
      truncated: false,
    },
  };
}

async function initializeRepository(root: string): Promise<void> {
  await runGit(root, ["init", "-q"]);
  await runGit(root, ["config", "user.email", "phase49@example.test"]);
  await runGit(root, ["config", "user.name", "Phase 49"]);

  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(root, "executable.sh"), "#!/bin/sh\necho base\n", "utf8");
  await writeFile(join(root, "delete.txt"), "delete me\n", "utf8");
  await writeFile(join(root, "rename-old.txt"), "rename me\n", "utf8");
  await writeFile(join(root, "copy-source.txt"), "copy source\n", "utf8");
  await writeFile(join(root, "target-a.txt"), "a\n", "utf8");
  await writeFile(join(root, "target-b.txt"), "b\n", "utf8");
  await symlink("target-a.txt", join(root, "link.txt"));

  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "-q", "-m", "base"]);
}

async function createRepresentativeChanges(root: string): Promise<void> {
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3, 255, 254, 253]));
  await chmod(join(root, "executable.sh"), 0o755);
  await unlink(join(root, "delete.txt"));
  await runGit(root, ["mv", "rename-old.txt", "rename-new.txt"]);
  await copyFile(join(root, "copy-source.txt"), join(root, "copy-new.txt"));
  await unlink(join(root, "link.txt"));
  await symlink("target-b.txt", join(root, "link.txt"));
  await writeFile(join(root, "untracked.txt"), "untracked\n", "utf8");
  await writeFile(join(root, "empty.txt"), "", "utf8");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "new.txt"), "nested\n", "utf8");
}

async function collectChangedFiles(root: string): Promise<readonly Phase49ChangedFile[]> {
  const trackedRaw = await runGit(root, ["diff", "--name-status", "-z", "--no-renames", "HEAD", "--"]);
  const untrackedRaw = await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const changed = new Map<string, Phase49ChangedFile>();

  const trackedTokens = splitNul(trackedRaw);
  assert.equal(trackedTokens.length % 2, 0);
  for (let index = 0; index < trackedTokens.length; index += 2) {
    const code = trackedTokens[index];
    const path = trackedTokens[index + 1];
    assert.ok(code !== undefined && path !== undefined);
    changed.set(path, { path, status: mapStatus(code) });
  }

  for (const path of splitNul(untrackedRaw)) {
    changed.set(path, { path, status: "untracked" });
  }

  return [...changed.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function collectPatch(root: string, changedFiles: readonly Phase49ChangedFile[]): Promise<string> {
  let patch = await runGit(root, ["diff", "--binary", "--no-ext-diff", "--no-renames", "HEAD", "--"]);
  for (const file of changedFiles) {
    if (file.status !== "untracked") {
      continue;
    }
    const result = await runGitAllowExit(root, ["diff", "--no-index", "--binary", "--", "/dev/null", file.path], [0, 1]);
    patch += result;
  }
  return patch;
}

function splitNul(value: string): string[] {
  const tokens = value.split("\0");
  if (tokens[tokens.length - 1] === "") {
    tokens.pop();
  }
  return tokens;
}

function mapStatus(code: string): Phase49ChangedFileStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "T":
      return "type_changed";
    case "U":
      return "unmerged";
    default:
      return "other";
  }
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return await runGitAllowExit(cwd, args, [0]);
}

async function runGitAllowExit(
  cwd: string,
  args: readonly string[],
  acceptedExitCodes: readonly number[],
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        const exitCode = typeof error.code === "number" ? error.code : -1;
        if (!acceptedExitCodes.includes(exitCode)) {
          rejectPromise(new Error(error.message, { cause: error }));
          return;
        }
      }
      resolvePromise(stdout);
    });
  });
}
