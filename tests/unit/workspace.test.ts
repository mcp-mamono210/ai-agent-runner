import assert from "node:assert/strict";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { TaskWorkspaceManager } from "../../src/sandbox/workspace.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";

void describe("Phase 48-4 task-scoped workspace", () => {
  void it("creates one isolated caller-owned checkout target and enforces disk bound", async () => {
    const base = await mkdtemp(join(tmpdir(), "agent-runner-workspace-test-"));
    try {
      const manager = new TaskWorkspaceManager({ root: base, diskLimitBytes: 8 });
      const workspace = await manager.create(EXECUTION_ID);

      assert.equal(workspace.executionId, EXECUTION_ID);
      assert.equal(dirname(workspace.path), await realpath(base));
      await writeFile(join(workspace.path, "small.txt"), "1234", "utf8");
      await workspace.assertWithinDiskLimit();
      await writeFile(join(workspace.path, "large.txt"), "12345678", "utf8");
      await assert.rejects(workspace.assertWithinDiskLimit(), /disk usage exceeded/u);

      await workspace.dispose();
      await assert.rejects(access(workspace.path));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
