import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { GitDevelopmentChangeSetCollector } from "../../src/development/change-set.js";

void describe("Phase 48-7 development change-set collection", () => {
  void it("captures tracked and untracked changes as a bounded local patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "phase48-7-change-set-"));
    try {
      await initializeRepository(root);
      await writeFile(join(root, "tracked.txt"), "base\nchanged\n", "utf8");
      await writeFile(join(root, "new.txt"), "new file\n", "utf8");

      const collector = new GitDevelopmentChangeSetCollector({ patchCaptureBytes: 64 * 1024 });
      const changeSet = await collector.collect(root);

      assert.deepEqual(changeSet.changedFiles, [
        { path: "new.txt", status: "untracked" },
        { path: "tracked.txt", status: "modified" },
      ]);
      assert.equal(changeSet.patch.truncated, false);
      assert.match(changeSet.patch.text, /tracked\.txt/u);
      assert.match(changeSet.patch.text, /new\.txt/u);
      assert.match(changeSet.patch.text, /\+changed/u);
      assert.match(changeSet.patch.text, /\+new file/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("preserves an observable truncation fact instead of retaining an unbounded patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "phase48-7-bounded-patch-"));
    try {
      await initializeRepository(root);
      await writeFile(join(root, "tracked.txt"), `base\n${"x".repeat(4096)}\n`, "utf8");

      const collector = new GitDevelopmentChangeSetCollector({ patchCaptureBytes: 128 });
      const changeSet = await collector.collect(root);

      assert.equal(changeSet.patch.truncated, true);
      assert.ok(changeSet.patch.capturedBytes <= 128);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function initializeRepository(root: string): Promise<void> {
  await runGit(root, ["init", "-q"]);
  await runGit(root, ["config", "user.email", "phase48@example.test"]);
  await runGit(root, ["config", "user.name", "Phase 48"]);
  await writeFile(join(root, "tracked.txt"), "base\n", "utf8");
  await runGit(root, ["add", "tracked.txt"]);
  await runGit(root, ["commit", "-q", "-m", "base"]);
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        rejectPromise(new Error(error.message, { cause: error }));
        return;
      }
      resolvePromise(stdout);
    });
  });
}
