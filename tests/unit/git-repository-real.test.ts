import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { GitCliRepositoryComponent } from "../../src/repository/git-repository.js";
import { RepositoryAccessPolicy, type RepositoryCredentialProvider } from "../../src/repository/policy.js";
import type { RepositoryAccessEntry, RepositoryCredential } from "../../src/repository/types.js";

class FixedCredentialProvider implements RepositoryCredentialProvider {
  getCredential(_entry: RepositoryAccessEntry): RepositoryCredential {
    return { username: "reader", password: "test-only" };
  }
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

void describe("GitCliRepositoryComponent real Git boundary", () => {
  void it("resolves a ref once and checks out the fixed commit without re-resolving it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-runner-real-git-"));
    const sourceDir = join(root, "source");
    const targetDir = join(root, "target");
    await mkdir(sourceDir);
    await mkdir(targetDir);

    try {
      runGit(sourceDir, ["init", "-q", "-b", "main"]);
      runGit(sourceDir, ["config", "user.name", "Agent Runner Test"]);
      runGit(sourceDir, ["config", "user.email", "agent-runner@example.test"]);
      await writeFile(join(sourceDir, "tracked.txt"), "phase-48-2\n", "utf8");
      runGit(sourceDir, ["add", "tracked.txt"]);
      runGit(sourceDir, ["commit", "-q", "-m", "fixture"]);
      const exactCommit = runGit(sourceDir, ["rev-parse", "HEAD"]);

      const entry: RepositoryAccessEntry = {
        repository: "example/repository",
        remoteUrl: `file://${sourceDir}`,
        sourceRef: "refs/heads/main",
        usernameEnv: "IGNORED_USER",
        passwordEnv: "IGNORED_PASSWORD",
      };
      const component = new GitCliRepositoryComponent({
        policy: new RepositoryAccessPolicy({ kind: "configured", entries: [entry] }),
        credentialProvider: new FixedCredentialProvider(),
      });

      const resolved = await component.resolveExactSource(entry.repository);
      assert.equal(resolved.sourceRevision, exactCommit);

      // Move the source branch after resolution. Checkout must remain pinned to
      // the previously fixed exact commit.
      await writeFile(join(sourceDir, "tracked.txt"), "moved-main\n", "utf8");
      runGit(sourceDir, ["add", "tracked.txt"]);
      runGit(sourceDir, ["commit", "-q", "-m", "move main"]);
      assert.notEqual(runGit(sourceDir, ["rev-parse", "HEAD"]), exactCommit);

      const checkout = await component.checkout({
        repository: entry.repository,
        sourceRevision: resolved.sourceRevision,
        targetDir,
      });
      assert.equal(checkout.headRevision, exactCommit);
      assert.equal(await readFile(join(targetDir, "tracked.txt"), "utf8"), "phase-48-2\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
