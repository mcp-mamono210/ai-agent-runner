import { spawn } from "node:child_process";

import type { DockerCommandRunner } from "../sandbox/docker-runtime.js";
import { NodeDockerCommandRunner } from "../sandbox/docker-runtime.js";
import { BoundedUtf8Capture } from "../sandbox/resource-policy.js";
import type { Redactor } from "../security/redaction.js";
import type {
  AgentAdapter,
  AgentAdapterInput,
  AgentExecutionCapture,
  AgentExecutionResult,
  CodexOneShotRunner,
  CodexProcessObservation,
  CodexProviderCredential,
  CodexProviderCredentialProvider,
  WorkingTreeChangeDetector,
} from "./types.js";

type Environment = Readonly<Record<string, string | undefined>>;

const CODEX_API_KEY_ENV = "AGENT_RUNNER_CODEX_API_KEY";
const CODEX_CONTAINER_API_KEY_ENV = "CODEX_API_KEY";
const CODEX_HOME = "/tmp/codex-home";
const WORKSPACE_PATH = "/workspace";

export class EnvironmentCodexProviderCredentialProvider
  implements CodexProviderCredentialProvider
{
  readonly #credential: CodexProviderCredential;

  constructor(environment: Environment = process.env) {
    const apiKey = environment[CODEX_API_KEY_ENV];
    if (apiKey === undefined || apiKey === "") {
      throw new Error(`${CODEX_API_KEY_ENV} is required for Codex CLI invocation`);
    }
    this.#credential = Object.freeze({ apiKey });
  }

  getCredential(): CodexProviderCredential {
    return this.#credential;
  }
}

export class CodexCliAgentAdapter implements AgentAdapter {
  readonly #credentialProvider: CodexProviderCredentialProvider;
  readonly #runner: CodexOneShotRunner;
  readonly #changeDetector: WorkingTreeChangeDetector;
  readonly #redactor: Redactor;

  constructor(input: {
    readonly credentialProvider: CodexProviderCredentialProvider;
    readonly runner: CodexOneShotRunner;
    readonly changeDetector?: WorkingTreeChangeDetector;
    readonly redactor: Redactor;
  }) {
    this.#credentialProvider = input.credentialProvider;
    this.#runner = input.runner;
    this.#changeDetector = input.changeDetector ?? new GitWorkingTreeChangeDetector();
    this.#redactor = input.redactor;
  }

  async runAgent(input: AgentAdapterInput): Promise<AgentExecutionResult> {
    if (input.workspace.executionId !== input.executionInput.executionId) {
      throw new Error("Agent Adapter workspace execution identity mismatch");
    }
    if (input.sandbox.executionId !== input.executionInput.executionId) {
      throw new Error("Agent Adapter sandbox execution identity mismatch");
    }

    const credential = this.#credentialProvider.getCredential();
    const observation = await this.#runner.run({
      containerId: input.sandbox.containerId,
      prompt: buildAgentPrompt(input.executionInput),
      apiKey: credential.apiKey,
      executionTimeoutMs: input.sandbox.resources.executionTimeoutMs,
      outputCaptureBytes: input.sandbox.resources.outputCaptureBytes,
      diagnosticCaptureBytes: input.sandbox.resources.diagnosticCaptureBytes,
      enforcementSignal: input.sandbox.enforcementSignal,
    });

    const output = redactCapture(observation.output, this.#redactor, "agent_output");
    const diagnostic = redactCapture(
      observation.diagnostic,
      this.#redactor,
      "agent_diagnostic",
    );

    if (observation.kind === "start_failed") {
      return Object.freeze({
        kind: "started_failure",
        outcome: "agent_start_failed",
        output,
        diagnostic,
      });
    }
    if (observation.kind === "aborted") {
      return Object.freeze({
        kind: "started_failure",
        outcome: observation.reason === "execution_timeout" ? "timeout" : "agent_failed",
        output,
        diagnostic,
      });
    }
    if (observation.exitCode !== 0) {
      return Object.freeze({
        kind: "started_failure",
        outcome: observation.exitCode === 126 || observation.exitCode === 127
          ? "agent_start_failed"
          : "agent_failed",
        output,
        diagnostic,
      });
    }

    await input.workspace.assertWithinDiskLimit();
    const hasChanges = await this.#changeDetector.hasChanges(input.workspace.path);
    return Object.freeze({
      kind: "provisional_success",
      outcome: hasChanges ? "changes_ready" : "no_changes",
      output,
      diagnostic,
    });
  }
}

export class DockerCodexOneShotRunner implements CodexOneShotRunner {
  readonly #dockerControl: DockerCommandRunner;

  constructor(dockerControl: DockerCommandRunner = new NodeDockerCommandRunner()) {
    this.#dockerControl = dockerControl;
  }

  async run(input: {
    readonly containerId: string;
    readonly prompt: string;
    readonly apiKey: string;
    readonly executionTimeoutMs: number;
    readonly outputCaptureBytes: number;
    readonly diagnosticCaptureBytes: number;
    readonly enforcementSignal: AbortSignal;
  }): Promise<CodexProcessObservation> {
    const output = new BoundedUtf8Capture(input.outputCaptureBytes);
    const diagnostic = new BoundedUtf8Capture(input.diagnosticCaptureBytes);

    try {
      await this.#dockerControl.run(["start", input.containerId]);
    } catch {
      diagnostic.append("Docker sandbox could not be started for Codex invocation");
      return Object.freeze({
        kind: "start_failed",
        output: output.snapshot(),
        diagnostic: diagnostic.snapshot(),
      });
    }

    try {
      await this.#dockerControl.run(["exec", input.containerId, "mkdir", "-p", CODEX_HOME]);
    } catch {
      diagnostic.append("Codex ephemeral state directory could not be prepared");
      return Object.freeze({
        kind: "start_failed",
        output: output.snapshot(),
        diagnostic: diagnostic.snapshot(),
      });
    }

    const timeoutSignal = AbortSignal.timeout(input.executionTimeoutMs);
    return await new Promise<CodexProcessObservation>((resolvePromise) => {
      const child = spawn("docker", buildCodexDockerExecArgs(input.containerId), {
        env: {
          ...process.env,
          [CODEX_CONTAINER_API_KEY_ENV]: input.apiKey,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let settled = false;
      let abortReason: "execution_timeout" | "sandbox_enforcement" | undefined;
      let timeoutKillPromise: Promise<void> | undefined;

      const finish = (result: CodexProcessObservation): void => {
        if (settled) {
          return;
        }
        settled = true;
        timeoutSignal.removeEventListener("abort", onTimeout);
        input.enforcementSignal.removeEventListener("abort", onEnforcement);
        resolvePromise(result);
      };
      const abort = (reason: "execution_timeout" | "sandbox_enforcement"): void => {
        if (settled || abortReason !== undefined) {
          return;
        }
        abortReason = reason;
        child.kill("SIGKILL");
        if (reason === "execution_timeout") {
          timeoutKillPromise = this.#dockerControl.run(["kill", input.containerId])
            .then(() => undefined)
            .catch(() => {
              diagnostic.append("Codex timeout container termination could not be confirmed");
            });
        }
      };
      const onTimeout = (): void => abort("execution_timeout");
      const onEnforcement = (): void => abort("sandbox_enforcement");

      timeoutSignal.addEventListener("abort", onTimeout, { once: true });
      input.enforcementSignal.addEventListener("abort", onEnforcement, { once: true });
      child.stdout.on("data", (chunk: Buffer) => output.append(chunk));
      child.stderr.on("data", (chunk: Buffer) => diagnostic.append(chunk));
      child.on("error", () => {
        diagnostic.append("Codex Docker exec process could not be started");
        finish(Object.freeze({
          kind: "start_failed",
          output: output.snapshot(),
          diagnostic: diagnostic.snapshot(),
        }));
      });
      child.on("close", (code) => {
        if (abortReason !== undefined) {
          const reason = abortReason;
          void Promise.resolve(timeoutKillPromise).then(() => {
            finish(Object.freeze({
              kind: "aborted",
              reason,
              output: output.snapshot(),
              diagnostic: diagnostic.snapshot(),
            }));
          });
          return;
        }
        finish(Object.freeze({
          kind: "completed",
          exitCode: code ?? 1,
          output: output.snapshot(),
          diagnostic: diagnostic.snapshot(),
        }));
      });
      child.stdin.on("error", () => {
        // Process close/error remains the authoritative result.
      });
      child.stdin.end(input.prompt, "utf8");
    });
  }
}

export class GitWorkingTreeChangeDetector implements WorkingTreeChangeDetector {
  async hasChanges(workspacePath: string): Promise<boolean> {
    return await new Promise<boolean>((resolvePromise, rejectPromise) => {
      const child = spawn(
        "git",
        ["-C", workspacePath, "status", "--porcelain=v1", "--untracked-files=all"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let settled = false;
      const resolveOnce = (value: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolvePromise(value);
      };
      child.stdout.on("data", () => {
        resolveOnce(true);
        child.kill("SIGTERM");
      });
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          rejectPromise(new Error("working-tree change detection failed", { cause: error }));
        }
      });
      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        if (code === 0) {
          resolveOnce(false);
          return;
        }
        rejectPromise(
          new Error(`working-tree change detection failed: code=${String(code)} signal=${String(signal)}`),
        );
      });
    });
  }
}

export function buildCodexDockerExecArgs(containerId: string): readonly string[] {
  return Object.freeze([
    "exec",
    "--interactive",
    "--workdir",
    WORKSPACE_PATH,
    "--env",
    CODEX_CONTAINER_API_KEY_ENV,
    "--env",
    `CODEX_HOME=${CODEX_HOME}`,
    containerId,
    "codex",
    "--ask-for-approval",
    "never",
    "--config",
    'shell_environment_policy.inherit="core"',
    "--config",
    "shell_environment_policy.ignore_default_excludes=false",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    "workspace-write",
    "-",
  ]);
}

function buildAgentPrompt(input: AgentAdapterInput["executionInput"]): string {
  const briefPath = `docs/agent-briefs/${input.issueId}/revisions/${input.briefRevision}.md`;
  return [
    `Implement Redmine Issue #${input.issueId} using the exact approved Agent Brief at ${briefPath}.`,
    "Treat that Brief as the executable contract and preserve its completion conditions.",
    `The immutable source revision for this attempt is ${input.sourceRevision}.`,
    "Work only inside the current /workspace checkout.",
    "Do not commit, push, open a pull request, or retry the Agent invocation.",
    "Run relevant local checks when useful, then stop after this one implementation attempt.",
  ].join("\n");
}

function redactCapture(
  capture: AgentExecutionCapture,
  redactor: Redactor,
  context: "agent_output" | "agent_diagnostic",
): AgentExecutionCapture {
  const text = redactor.redact(capture.text, context);
  return Object.freeze({
    text,
    capturedBytes: Buffer.byteLength(text, "utf8"),
    truncated: capture.truncated,
  });
}
