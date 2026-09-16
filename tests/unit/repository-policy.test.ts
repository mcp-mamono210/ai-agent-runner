import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EnvironmentRepositoryCredentialProvider,
  parseRepositoryAccessEntries,
  RepositoryAccessPolicy,
} from "../../src/repository/policy.js";
import { RepositoryAccessError } from "../../src/repository/types.js";

const ENTRY =
  "mcp-mamono210/redmine|https://github.com/mcp-mamono210/redmine.git|refs/heads/main|AGENT_RUNNER_GIT_USERNAME|AGENT_RUNNER_GIT_READ_TOKEN";

void describe("repository authorization policy", () => {
  void it("treats an explicitly empty configuration as an empty allowlist", () => {
    assert.deepEqual(parseRepositoryAccessEntries(""), []);
  });

  void it("fails closed when authorization configuration is missing", () => {
    assert.throws(
      () => parseRepositoryAccessEntries(undefined),
      (error: unknown) =>
        error instanceof RepositoryAccessError &&
        error.code === "authorization_configuration_invalid",
    );
  });

  void it("normalizes only configured ASCII edge whitespace and preserves runtime identity", () => {
    const entries = parseRepositoryAccessEntries(`  mcp-mamono210/redmine\t|https://github.com/mcp-mamono210/redmine.git|refs/heads/main|AGENT_RUNNER_GIT_USERNAME|AGENT_RUNNER_GIT_READ_TOKEN`);
    const policy = new RepositoryAccessPolicy({ kind: "configured", entries });

    assert.equal(policy.authorize("mcp-mamono210/redmine").repository, "mcp-mamono210/redmine");
    assert.throws(
      () => policy.authorize("MCP-MAMONO210/REDMINE"),
      (error: unknown) =>
        error instanceof RepositoryAccessError &&
        error.code === "repository_unauthorized",
    );
  });

  void it("rejects duplicate normalized repository identities", () => {
    assert.throws(
      () => parseRepositoryAccessEntries(`${ENTRY}; ${ENTRY}`),
      (error: unknown) =>
        error instanceof RepositoryAccessError &&
        error.code === "authorization_configuration_invalid",
    );
  });

  void it("does not allow credentials to be embedded in the remote URL", () => {
    assert.throws(
      () => parseRepositoryAccessEntries(
        "mcp-mamono210/redmine|https://user:secret@github.com/mcp-mamono210/redmine.git|refs/heads/main|AGENT_RUNNER_GIT_USERNAME|AGENT_RUNNER_GIT_READ_TOKEN",
      ),
      RepositoryAccessError,
    );
  });

  void it("reads repository credentials only through configured environment names", () => {
    const entry = parseRepositoryAccessEntries(ENTRY)[0]!;
    const provider = new EnvironmentRepositoryCredentialProvider({
      AGENT_RUNNER_GIT_USERNAME: "x-access-token",
      AGENT_RUNNER_GIT_READ_TOKEN: "read-token",
    });

    assert.deepEqual(provider.getCredential(entry), {
      username: "x-access-token",
      password: "read-token",
    });
  });
});
