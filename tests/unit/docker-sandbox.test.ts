import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DockerSandboxRuntime,
  type DockerCommandRunner,
} from "../../src/sandbox/docker-runtime.js";
import { parseSandboxNetworkPolicy } from "../../src/sandbox/network-policy.js";
import type {
  SandboxRuntimeConfig,
  TaskWorkspace,
} from "../../src/sandbox/types.js";
import type { PreparedExecution } from "../../src/execution/types.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CONTAINER_ID = "a".repeat(64);
const WORKSPACE = "/var/lib/ai-agent-runner/workspaces/attempt-test";

function networkPolicy() {
  return parseSandboxNetworkPolicy({
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
    dockerNetworkName: "agent-runner-egress",
    proxyContainerName: "agent-runner-egress-proxy",
    proxyUrl: "http://agent-runner-egress-proxy:3128",
  });
}

function sandboxConfig(): SandboxRuntimeConfig {
  return {
    runtime: "docker",
    agentProvider: "codex-cli",
    image: `registry.example.test/agent-codex@sha256:${"b".repeat(64)}`,
    workspaceRoot: "/var/lib/ai-agent-runner/workspaces",
    network: networkPolicy(),
    resources: {
      executionTimeoutMs: 60000,
      outputCaptureBytes: 1024,
      diagnosticCaptureBytes: 1024,
      workspaceDiskBytes: 1024 * 1024,
      containerLifecycleMs: 120000,
      workspaceCheckIntervalMs: 60000,
      tmpfsBytes: 1024 * 1024,
    },
  };
}

function execution(): PreparedExecution {
  const pending = Object.freeze({ kind: "pending" }) satisfies { readonly kind: "pending" };
  const approvedBriefReference = Object.freeze({
    repository: "mcp-mamono210/redmine",
    issueId: 5413,
    briefRevision: 1,
    persistedRevision: "persisted-revision",
  });
  const input = Object.freeze({
    executionId: EXECUTION_ID,
    issueId: 5413,
    repository: approvedBriefReference.repository,
    sourceRevision: "c".repeat(40),
    briefRevision: 1,
    persistedRevision: "persisted-revision",
    requirementsFingerprint: `sha256:${"d".repeat(64)}`,
    approvedBriefReference,
  });
  return Object.freeze({
    issue: { issueId: 5413, projectId: 414, lifecycle: "Ready for Agent", raw: {} },
    handoff: {
      issueId: 5413,
      repository: input.repository,
      approvedRequirementsFingerprint: input.requirementsFingerprint,
      opaque: {},
    },
    input,
    record: Object.freeze({
      executionId: input.executionId,
      issueId: input.issueId,
      briefRevision: input.briefRevision,
      persistedRevision: input.persistedRevision,
      requirementsFingerprint: input.requirementsFingerprint,
      repository: input.repository,
      sourceRevision: input.sourceRevision,
      startedAt: "2026-09-19T00:00:00.000Z",
      finishedAt: pending,
      outcome: pending,
      artifactReference: pending,
    }),
  });
}

class FakeWorkspace implements TaskWorkspace {
  readonly executionId = EXECUTION_ID;
  readonly path = WORKSPACE;
  readonly diskLimitBytes = 1024 * 1024;
  disposed = false;
  diskChecks = 0;

  measureDiskUsageBytes(): Promise<number> {
    return Promise.resolve(0);
  }

  assertWithinDiskLimit(): Promise<void> {
    this.diskChecks += 1;
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

class FakeDockerRunner implements DockerCommandRunner {
  readonly calls: string[][] = [];
  networkInternal = true;
  extraMount = false;
  forbiddenEnv = false;

  constructor(readonly policyDigest: string) {}

  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    if (args[0] === "network" && args[1] === "inspect") {
      return Promise.resolve(JSON.stringify({
        Internal: this.networkInternal,
        Labels: { "io.mcp.agent-runner.egress-policy-sha256": this.policyDigest },
      }));
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === "agent-runner-egress-proxy") {
      return Promise.resolve(JSON.stringify({
        State: { Running: true },
        Config: {
          Labels: {
            "io.mcp.agent-runner.egress-proxy": "true",
            "io.mcp.agent-runner.egress-policy-sha256": this.policyDigest,
          },
        },
        NetworkSettings: { Networks: { "agent-runner-egress": {} } },
      }));
    }
    if (args[0] === "create") {
      return Promise.resolve(`${CONTAINER_ID}\n`);
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === CONTAINER_ID) {
      const mounts: Array<Record<string, unknown>> = [
        { Type: "bind", Source: WORKSPACE, Destination: "/workspace", RW: true },
      ];
      if (this.extraMount) {
        mounts.push({
          Type: "bind",
          Source: "/var/run/docker.sock",
          Destination: "/var/run/docker.sock",
          RW: true,
        });
      }
      const env = [
        "HTTP_PROXY=http://agent-runner-egress-proxy:3128",
        ...(this.forbiddenEnv ? ["REDMINE_WRITE_API_KEY=secret"] : []),
      ];
      return Promise.resolve(JSON.stringify({
        HostConfig: {
          Privileged: false,
          ReadonlyRootfs: true,
          NetworkMode: "agent-runner-egress",
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
        },
        Config: {
          Labels: {
            "io.mcp.agent-runner.sandbox": "true",
            "io.mcp.agent-runner.execution-id": EXECUTION_ID,
            "io.mcp.agent-runner.egress-policy-sha256": this.policyDigest,
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

void describe("Phase 48-4 Docker sandbox enforcement", () => {
  void it("creates a read-only, capability-dropped sandbox with only task workspace host mount", async () => {
    const config = sandboxConfig();
    const docker = new FakeDockerRunner(config.network.digest);
    const workspace = new FakeWorkspace();
    const runtime = new DockerSandboxRuntime({ config, dockerRunner: docker });

    const handle = await runtime.create({ execution: execution(), workspace });
    const evidence = await handle.inspectIsolation();

    assert.equal(evidence.workspaceSource, WORKSPACE);
    assert.equal(evidence.workspaceDestination, "/workspace");
    const createCall = docker.calls.find((call) => call[0] === "create");
    assert.ok(createCall !== undefined);
    assert.ok(createCall.includes("--read-only"));
    assert.ok(createCall.includes("--cap-drop=ALL"));
    assert.equal(createCall.some((entry) => entry.includes("REDMINE_")), false);
    assert.equal(createCall.some((entry) => entry.includes("AGENT_RUNNER_GIT_")), false);

    await handle.dispose("success");
    assert.equal(workspace.disposed, true);
    assert.ok(docker.calls.some((call) => call[0] === "rm" && call[1] === "-f"));
  });

  void it("fails closed when managed Docker network would allow direct egress", async () => {
    const config = sandboxConfig();
    const docker = new FakeDockerRunner(config.network.digest);
    docker.networkInternal = false;
    const runtime = new DockerSandboxRuntime({ config, dockerRunner: docker });

    await assert.rejects(
      runtime.create({ execution: execution(), workspace: new FakeWorkspace() }),
      /must be internal/u,
    );
    assert.equal(docker.calls.some((call) => call[0] === "create"), false);
  });

  void it("rejects extra host mount or Controller credential exposure and removes partial sandbox", async () => {
    const config = sandboxConfig();
    const docker = new FakeDockerRunner(config.network.digest);
    docker.extraMount = true;
    const runtime = new DockerSandboxRuntime({ config, dockerRunner: docker });

    await assert.rejects(
      runtime.create({ execution: execution(), workspace: new FakeWorkspace() }),
      /only host-backed sandbox mount/u,
    );
    assert.ok(docker.calls.some((call) => call[0] === "rm" && call[1] === "-f"));

    const credentialDocker = new FakeDockerRunner(config.network.digest);
    credentialDocker.forbiddenEnv = true;
    await assert.rejects(
      new DockerSandboxRuntime({ config, dockerRunner: credentialDocker }).create({
        execution: execution(),
        workspace: new FakeWorkspace(),
      }),
      /forbidden Controller credential/u,
    );
  });

  void it("enforces a finite container lifecycle even without downstream completion", async () => {
    const base = sandboxConfig();
    const config: SandboxRuntimeConfig = {
      ...base,
      resources: {
        ...base.resources,
        executionTimeoutMs: 10,
        containerLifecycleMs: 25,
        workspaceCheckIntervalMs: 1000,
      },
    };
    const docker = new FakeDockerRunner(config.network.digest);
    const handle = await new DockerSandboxRuntime({ config, dockerRunner: docker }).create({
      execution: execution(),
      workspace: new FakeWorkspace(),
    });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));

    assert.equal(handle.enforcementSignal.aborted, true);
    assert.ok(docker.calls.some((call) => call[0] === "rm" && call[1] === "-f"));
    await handle.dispose("lifecycle_limit");
  });
});
