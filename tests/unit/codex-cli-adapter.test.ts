import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCodexDockerExecArgs,
  CodexCliAgentAdapter,
} from "../../src/agent/codex-cli-adapter.js";
import type {
  CodexOneShotRunner,
  CodexProcessObservation,
} from "../../src/agent/types.js";
import type { ImmutableExecutionInput } from "../../src/execution/types.js";
import { KnownSecretRedactor } from "../../src/security/redaction.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECRET = "codex-fixture-secret";

function executionInput(): ImmutableExecutionInput {
  return Object.freeze({
    executionId: EXECUTION_ID,
    issueId: 5414,
    repository: "mcp-mamono210/redmine",
    sourceRevision: "a".repeat(40),
    briefRevision: 4,
    persistedRevision: "persisted-revision",
    requirementsFingerprint: `sha256:${"b".repeat(64)}`,
    approvedBriefReference: Object.freeze({
      repository: "mcp-mamono210/redmine",
      issueId: 5414,
      briefRevision: 4,
      persistedRevision: "persisted-revision",
    }),
  });
}

function input() {
  const enforcement = new AbortController();
  return {
    workspace: {
      executionId: EXECUTION_ID,
      path: "/tmp/workspace",
      diskLimitBytes: 1024,
      measureDiskUsageBytes: () => Promise.resolve(0),
      assertWithinDiskLimit: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
    },
    sandbox: {
      containerId: "c".repeat(64),
      executionId: EXECUTION_ID,
      workspace: {
        executionId: EXECUTION_ID,
        path: "/tmp/workspace",
        diskLimitBytes: 1024,
        measureDiskUsageBytes: () => Promise.resolve(0),
        assertWithinDiskLimit: () => Promise.resolve(),
        dispose: () => Promise.resolve(),
      },
      resources: {
        executionTimeoutMs: 1000,
        outputCaptureBytes: 1024,
        diagnosticCaptureBytes: 1024,
        workspaceDiskBytes: 1024,
        containerLifecycleMs: 2000,
        workspaceCheckIntervalMs: 100,
        tmpfsBytes: 1024,
      },
      enforcementSignal: enforcement.signal,
      inspectIsolation: () => Promise.resolve({
        containerId: "c".repeat(64),
        workspaceSource: "/tmp/workspace",
        workspaceDestination: "/workspace" as const,
        networkName: "network",
        policyDigest: `sha256:${"d".repeat(64)}`,
      }),
      dispose: () => Promise.resolve(),
    },
    executionInput: executionInput(),
  };
}

function completed(exitCode: number): CodexProcessObservation {
  return {
    kind: "completed",
    exitCode,
    output: { text: `output ${SECRET}`, capturedBytes: 10, truncated: false },
    diagnostic: { text: `token=${SECRET}`, capturedBytes: 10, truncated: false },
  };
}

void describe("Phase 48-5 Codex CLI Agent Adapter", () => {
  void it("performs one invocation, redacts bounded captures, and returns changes_ready provisionally", async () => {
    let calls = 0;
    let prompt = "";
    const runner: CodexOneShotRunner = {
      run: (request) => {
        calls += 1;
        prompt = request.prompt;
        assert.equal(request.apiKey, SECRET);
        return Promise.resolve(completed(0));
      },
    };
    const adapter = new CodexCliAgentAdapter({
      credentialProvider: { getCredential: () => ({ apiKey: SECRET }) },
      runner,
      changeDetector: { hasChanges: () => Promise.resolve(true) },
      redactor: new KnownSecretRedactor([SECRET]),
    });

    const result = await adapter.runAgent(input());

    assert.equal(calls, 1);
    assert.match(prompt, /docs\/agent-briefs\/5414\/revisions\/4\.md/u);
    assert.equal(result.kind, "provisional_success");
    assert.equal(result.outcome, "changes_ready");
    assert.doesNotMatch(result.output.text, new RegExp(SECRET, "u"));
    assert.doesNotMatch(result.diagnostic.text, new RegExp(SECRET, "u"));
  });

  void it("maps timeout without retrying", async () => {
    let calls = 0;
    const runner: CodexOneShotRunner = {
      run: () => {
        calls += 1;
        return Promise.resolve({
          kind: "aborted",
          reason: "execution_timeout",
          output: { text: "", capturedBytes: 0, truncated: false },
          diagnostic: { text: "timeout", capturedBytes: 7, truncated: false },
        });
      },
    };
    const adapter = new CodexCliAgentAdapter({
      credentialProvider: { getCredential: () => ({ apiKey: SECRET }) },
      runner,
      changeDetector: { hasChanges: () => Promise.reject(new Error("must not inspect")) },
      redactor: new KnownSecretRedactor([SECRET]),
    });

    const result = await adapter.runAgent(input());

    assert.equal(calls, 1);
    assert.equal(result.kind, "started_failure");
    assert.equal(result.outcome, "timeout");
  });

  void it("maps provider exit failures and reserves 126/127 for agent_start_failed", async () => {
    for (const [exitCode, expected] of [[7, "agent_failed"], [127, "agent_start_failed"]] as const) {
      let calls = 0;
      const adapter = new CodexCliAgentAdapter({
        credentialProvider: { getCredential: () => ({ apiKey: SECRET }) },
        runner: {
          run: () => {
            calls += 1;
            return Promise.resolve(completed(exitCode));
          },
        },
        changeDetector: { hasChanges: () => Promise.reject(new Error("must not inspect")) },
        redactor: new KnownSecretRedactor([SECRET]),
      });

      const observed = await adapter.runAgent(input());

      assert.equal(calls, 1);
      assert.equal(observed.kind, "started_failure");
      assert.equal(observed.outcome, expected);
    }
  });

  void it("fails without returning raw capture when redaction itself fails", async () => {
    const adapter = new CodexCliAgentAdapter({
      credentialProvider: { getCredential: () => ({ apiKey: SECRET }) },
      runner: { run: () => Promise.resolve(completed(0)) },
      changeDetector: { hasChanges: () => Promise.resolve(false) },
      redactor: { redact: () => { throw new Error("redaction failed"); } },
    });

    await assert.rejects(adapter.runAgent(input()), /redaction failed/u);
  });

  void it("builds Codex exec argv without embedding provider secret and excludes key-like vars from shell children", () => {
    const args = buildCodexDockerExecArgs("c".repeat(64));
    const serialized = args.join(" ");

    assert.match(serialized, /codex .*--ask-for-approval never .*exec .*--ephemeral/u);
    assert.match(serialized, /--sandbox workspace-write/u);
    assert.match(serialized, /--env CODEX_API_KEY/u);
    assert.match(serialized, /shell_environment_policy\.ignore_default_excludes=false/u);
    assert.doesNotMatch(serialized, new RegExp(SECRET, "u"));
  });
});
