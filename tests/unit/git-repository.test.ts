import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  GitCliRepositoryComponent,
  type GitCommandInput,
  type GitCommandRunner,
} from "../../src/repository/git-repository.js";
import {
  RepositoryAccessPolicy,
  type RepositoryCredentialProvider,
} from "../../src/repository/policy.js";
import {
  RepositoryAccessError,
  type RepositoryAccessEntry,
  type RepositoryCredential,
} from "../../src/repository/types.js";

const SOURCE_REVISION = "a".repeat(40);
const ENTRY: RepositoryAccessEntry = {
  repository: "mcp-mamono210/redmine",
  remoteUrl: "https://github.com/mcp-mamono210/redmine.git",
  sourceRef: "refs/heads/main",
  usernameEnv: "GIT_USER",
  passwordEnv: "GIT_TOKEN",
};

class RecordingCredentialProvider implements RepositoryCredentialProvider {
  calls = 0;

  getCredential(_entry: RepositoryAccessEntry): RepositoryCredential {
    this.calls += 1;
    return { username: "reader", password: "secret" };
  }
}

class RecordingGitRunner implements GitCommandRunner {
  readonly calls: GitCommandInput[] = [];

  run(input: GitCommandInput): Promise<string> {
    this.calls.push(input);
    if (input.args[0] === "rev-parse") {
      return Promise.resolve(`${SOURCE_REVISION}\n`);
    }
    return Promise.resolve("");
  }
}

void describe("GitCliRepositoryComponent", () => {
  void it("fails invalid authorization configuration before consulting credentials", async () => {
    const credentials = new RecordingCredentialProvider();
    const git = new RecordingGitRunner();
    const component = new GitCliRepositoryComponent({
      policy: new RepositoryAccessPolicy({
        kind: "invalid",
        diagnostic: "configuration unavailable",
      }),
      credentialProvider: credentials,
      gitRunner: git,
    });

    await assert.rejects(
      component.resolveExactSource(ENTRY.repository),
      (error: unknown) =>
        error instanceof RepositoryAccessError &&
        error.code === "authorization_configuration_invalid",
    );
    assert.equal(credentials.calls, 0);
    assert.equal(git.calls.length, 0);
  });

  void it("fails the early pre-check before consulting credentials", async () => {
    const credentials = new RecordingCredentialProvider();
    const git = new RecordingGitRunner();
    const component = new GitCliRepositoryComponent({
      policy: new RepositoryAccessPolicy({ kind: "configured", entries: [ENTRY] }),
      credentialProvider: credentials,
      gitRunner: git,
    });

    await assert.rejects(
      component.resolveExactSource("mcp-mamono210/other"),
      (error: unknown) =>
        error instanceof RepositoryAccessError &&
        error.code === "repository_unauthorized",
    );
    assert.equal(credentials.calls, 0);
    assert.equal(git.calls.length, 0);
  });

  void it("resolves the configured moving ref to one exact immutable commit", async () => {
    const credentials = new RecordingCredentialProvider();
    const git = new RecordingGitRunner();
    const component = new GitCliRepositoryComponent({
      policy: new RepositoryAccessPolicy({ kind: "configured", entries: [ENTRY] }),
      credentialProvider: credentials,
      gitRunner: git,
    });

    const resolved = await component.resolveExactSource(ENTRY.repository);

    assert.deepEqual(resolved, {
      repository: ENTRY.repository,
      sourceRevision: SOURCE_REVISION,
    });
    assert.equal(credentials.calls, 1);
    const fetchCall = git.calls.find((call) => call.args[0] === "fetch");
    assert.ok(fetchCall !== undefined);
    assert.equal(fetchCall.args.at(-1), ENTRY.sourceRef);
    assert.deepEqual(fetchCall.credential, {
      username: "reader",
      password: "secret",
    });
  });

  void it("checks out only the already-fixed source revision into a caller-owned directory", async () => {
    const targetDir = await mkdtemp(join(tmpdir(), "agent-runner-checkout-test-"));
    try {
      const credentials = new RecordingCredentialProvider();
      const git = new RecordingGitRunner();
      const component = new GitCliRepositoryComponent({
        policy: new RepositoryAccessPolicy({ kind: "configured", entries: [ENTRY] }),
        credentialProvider: credentials,
        gitRunner: git,
      });

      const result = await component.checkout({
        repository: ENTRY.repository,
        sourceRevision: SOURCE_REVISION,
        targetDir,
      });

      assert.equal(result.headRevision, SOURCE_REVISION);
      assert.equal(result.targetDir, targetDir);
      const fetchCall = git.calls.find((call) => call.args[0] === "fetch");
      assert.ok(fetchCall !== undefined);
      assert.equal(fetchCall.args.at(-1), SOURCE_REVISION);
      assert.equal(fetchCall.args.includes(ENTRY.sourceRef), false);
      const checkoutCall = git.calls.find((call) => call.args[0] === "checkout");
      assert.ok(checkoutCall !== undefined);
      assert.equal(checkoutCall.args.at(-1), SOURCE_REVISION);
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});
