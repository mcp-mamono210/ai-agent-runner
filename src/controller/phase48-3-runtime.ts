import type { AgentController } from "./controller.js";
import {
  createPhase48_2ProductionRuntime,
  loadPhase48_2RuntimeConfig,
  type Phase48_2ProductionRuntime,
  type Phase48_2RuntimeConfig,
} from "./phase48-2-runtime.js";
import type { StartupReconciler } from "./types.js";
import { Phase47FormalAuthorizationGate } from "../execution/formal-gate.js";
import {
  Phase48_3ExactSourceResolvedHandler,
} from "../execution/preparation.js";
import type {
  AgentRunningConfirmedHandler,
  ExecutionIdAllocator,
} from "../execution/types.js";
import { RedmineAgentRunningWriter } from "../redmine/execution-writer.js";
import { RedminePreExecutionRejectionWriter } from "../redmine/rejection-writer.js";
import { RedmineRestClient } from "../redmine/rest-client.js";
import type { GitCommandRunner } from "../repository/git-repository.js";
import { RepositoryAccessPolicy } from "../repository/policy.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface Phase48_3RuntimeConfig {
  readonly phase48_2: Phase48_2RuntimeConfig;
}

export interface Phase48_3ProductionRuntime {
  readonly controller: AgentController;
  readonly repository: Phase48_2ProductionRuntime["repository"];
}

export function loadPhase48_3RuntimeConfig(
  env: Environment = process.env,
): Phase48_3RuntimeConfig {
  return { phase48_2: loadPhase48_2RuntimeConfig(env) };
}

export function createPhase48_3ProductionRuntime(input: {
  readonly config: Phase48_3RuntimeConfig;
  readonly startupReconciler: StartupReconciler;
  readonly agentRunningConfirmedHandler: AgentRunningConfirmedHandler;
  readonly executionIdAllocator?: ExecutionIdAllocator;
  readonly clock?: () => Date;
  readonly environment?: Environment;
  readonly fetchImpl?: typeof fetch;
  readonly gitRunner?: GitCommandRunner;
}): Phase48_3ProductionRuntime {
  const phase48_1 = input.config.phase48_2.phase48_1;
  const redmineClient = new RedmineRestClient({
    baseUrl: phase48_1.redmine.baseUrl,
    readApiKey: phase48_1.redmine.readApiKey,
    writeApiKey: phase48_1.redmine.writeApiKey,
    timeoutMs: phase48_1.redmine.timeoutMs,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  const rejectionWriter = new RedminePreExecutionRejectionWriter({
    client: redmineClient,
    allowedProjectIds: phase48_1.controller.allowedProjectIds,
    secretValues: [phase48_1.redmine.readApiKey, phase48_1.redmine.writeApiKey],
  });
  const agentRunningWriter = new RedmineAgentRunningWriter({
    client: redmineClient,
    allowedProjectIds: phase48_1.controller.allowedProjectIds,
  });
  const formalGate = new Phase47FormalAuthorizationGate(
    new RepositoryAccessPolicy(input.config.phase48_2.repositoryAuthorization),
  );
  const preparationHandler = new Phase48_3ExactSourceResolvedHandler({
    formalGate,
    rejectionWriter,
    agentRunningWriter,
    next: input.agentRunningConfirmedHandler,
    ...(input.executionIdAllocator === undefined
      ? {}
      : { executionIdAllocator: input.executionIdAllocator }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });

  const phase48_2Runtime = createPhase48_2ProductionRuntime({
    config: input.config.phase48_2,
    startupReconciler: input.startupReconciler,
    exactSourceResolvedHandler: preparationHandler,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.gitRunner === undefined ? {} : { gitRunner: input.gitRunner }),
  });

  return {
    controller: phase48_2Runtime.controller,
    repository: phase48_2Runtime.repository,
  };
}
