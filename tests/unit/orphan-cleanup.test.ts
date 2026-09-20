import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DockerWorkspaceOrphanCleaner } from "../../src/recovery/orphan-cleanup.js";
import type { DockerCommandRunner } from "../../src/sandbox/docker-runtime.js";

const ID1 = "123e4567-e89b-42d3-a456-426614174000";
const ID2 = "223e4567-e89b-42d3-a456-426614174001";

void describe("Phase 48-6 orphan runtime cleanup", () => {
  void it("removes only Agent Runner sandbox containers and owned attempt workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "phase48-6-cleanup-"));
    try {
      const attempt1 = join(root, `attempt-${ID1}-abc123`);
      const attempt2 = join(root, `attempt-${ID2}-def456`);
      const unrelated = join(root, "keep-me");
      await mkdir(attempt1);
      await mkdir(attempt2);
      await mkdir(unrelated);

      const calls: readonly string[][] = [];
      const mutableCalls = calls as string[][];
      const docker: DockerCommandRunner = {
        run: (args) => {
          mutableCalls.push([...args]);
          if (args[0] === "ps") {
            return Promise.resolve(`${"a".repeat(64)}\n${"b".repeat(64)}\n`);
          }
          return Promise.resolve("");
        },
      };
      const cleaner = new DockerWorkspaceOrphanCleaner({ docker, workspaceRoot: root });

      const summary = await cleaner.cleanup();

      assert.deepEqual(summary, { removedSandboxContainers: 2, removedWorkspaces: 2 });
      assert.deepEqual(mutableCalls[0], [
        "ps",
        "-aq",
        "--filter",
        "label=io.mcp.agent-runner.sandbox=true",
      ]);
      assert.deepEqual(mutableCalls.slice(1), [
        ["rm", "-f", "a".repeat(64)],
        ["rm", "-f", "b".repeat(64)],
      ]);
      assert.deepEqual(await readdir(root), ["keep-me"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("fails closed for an owned-looking symlink instead of following it", async () => {
    const root = await mkdtemp(join(tmpdir(), "phase48-6-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "phase48-6-outside-"));
    try {
      const linked = join(root, `attempt-${ID1}-abc123`);
      await symlink(outside, linked);
      const cleaner = new DockerWorkspaceOrphanCleaner({
        workspaceRoot: root,
        docker: { run: () => Promise.resolve("") },
      });

      await assert.rejects(cleaner.cleanup(), /not a real directory/u);
      await access(outside);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
