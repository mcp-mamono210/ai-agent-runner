import type { AgentController } from "./controller.js";
import {
  createPhase48_3ProductionRuntime,
  loadPhase48_3RuntimeConfig,
  type Phase48_3ProductionRuntime,
  type Phase48_3RuntimeConfig,
} from "./phase48-3-runtime.js";
import type { StartupReconciler } from "./types.js";
import type { ExecutionIdAllocator } from "../execution/types.js";
import { GitCliRepositoryComponent, type GitCommandRunner } from "../repository/git-repository.js";
import {
  EnvironmentRepositoryCredentialProvider,
  RepositoryAccessPolicy,
} from "../repository/policy.js";
import {
  loadSandboxRuntimeConfig,
} from "../sandbox/config.js";
import {
  DockerSandboxRuntime,
  type DockerCommandRunner,
} from "../sandbox/docker-runtime.js";
import { Phase48_4AgentRunningConfirmedHandler } from "../sandbox/phase48-4-handler.js";
import type {
  SandboxPreparationFailureHandler,
  SandboxPreparedHandler,
  SandboxRuntimeConfig,
} from "../sandbox/types.js";
import { TaskWorkspaceManager } from "../sandbox/workspace.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface Phase48_4RuntimeConfig {
  readonly phase48_3: Phase48_3RuntimeConfig;
  readonly sandbox: SandboxRuntimeConfig;
}

export interface Phase48_4ProductionRuntime {
  readonly controller: AgentController;
  readonly repository: Phase48_3ProductionRuntime["repository"];
  readonly sandboxConfig: SandboxRuntimeConfig;
}

export function loadPhase48_4RuntimeConfig(
  env: Environment = process.env,
): Phase48_4RuntimeConfig {
  return Object.freeze({
    phase48_3: loadPhase48_3RuntimeConfig(env),
    sandbox: loadSandboxRuntimeConfig(env),
  });
}

export function createPhase48_4ProductionRuntime(input: {
  readonly config: Phase48_4RuntimeConfig;
  readonly startupReconciler: StartupReconciler;
  readonly sandboxPreparedHandler: SandboxPreparedHandler;
  readonly preAgentFailureHandler: SandboxPreparationFailureHandler;
  readonly executionIdAllocator?: ExecutionIdAllocator;
  readonly clock?: () => Date;
  readonly environment?: Environment;
  readonly fetchImpl?: typeof fetch;
  readonly gitRunner?: GitCommandRunner;
  readonly dockerRunner?: DockerCommandRunner;
}): Phase48_4ProductionRuntime {
  const environment = input.environment ?? process.env;
  const repositoryPolicy = new RepositoryAccessPolicy(
    input.config.phase48_3.phase48_2.repositoryAuthorization,
  );
  const checkoutRepository = new GitCliRepositoryComponent({
    policy: repositoryPolicy,
    credentialProvider: new EnvironmentRepositoryCredentialProvider(environment),
    ...(input.gitRunner === undefined ? {} : { gitRunner: input.gitRunner }),
  });
  const workspaceManager = new TaskWorkspaceManager({
    root: input.config.sandbox.workspaceRoot,
    diskLimitBytes: input.config.sandbox.resources.workspaceDiskBytes,
  });
  const sandboxRuntime = new DockerSandboxRuntime({
    config: input.config.sandbox,
    ...(input.dockerRunner === undefined ? {} : { dockerRunner: input.dockerRunner }),
  });
  const phase48_4Handler = new Phase48_4AgentRunningConfirmedHandler({
    workspaceManager,
    repository: checkoutRepository,
    sandboxRuntime,
    next: input.sandboxPreparedHandler,
    preAgentFailureHandler: input.preAgentFailureHandler,
  });

  const phase48_3Runtime = createPhase48_3ProductionRuntime({
    config: input.config.phase48_3,
    startupReconciler: input.startupReconciler,
    agentRunningConfirmedHandler: phase48_4Handler,
    ...(input.executionIdAllocator === undefined
      ? {}
      : { executionIdAllocator: input.executionIdAllocator }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.gitRunner === undefined ? {} : { gitRunner: input.gitRunner }),
  });

  return {
    controller: phase48_3Runtime.controller,
    repository: phase48_3Runtime.repository,
    sandboxConfig: input.config.sandbox,
  };
}
