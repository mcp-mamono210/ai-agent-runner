import type { AgentController } from "./controller.js";
import {
  createPhase48_1ProductionController,
  loadPhase48_1RuntimeConfig,
  type Phase48_1RuntimeConfig,
} from "./production-runtime.js";
import type { StartupReconciler } from "./types.js";
import { RedminePreExecutionRejectionWriter } from "../redmine/rejection-writer.js";
import { RedmineRestClient } from "../redmine/rest-client.js";
import { GitCliRepositoryComponent, type GitCommandRunner } from "../repository/git-repository.js";
import {
  EnvironmentRepositoryCredentialProvider,
  loadRepositoryAuthorizationConfiguration,
  RepositoryAccessPolicy,
} from "../repository/policy.js";
import { Phase48_2EligibleCandidateHandler } from "../repository/phase48-2-handler.js";
import type {
  ExactSourceResolvedHandler,
  RepositoryAuthorizationConfiguration,
} from "../repository/types.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface Phase48_2RuntimeConfig {
  readonly phase48_1: Phase48_1RuntimeConfig;
  readonly repositoryAuthorization: RepositoryAuthorizationConfiguration;
}

export interface Phase48_2ProductionRuntime {
  readonly controller: AgentController;
  readonly repository: GitCliRepositoryComponent;
}

export function loadPhase48_2RuntimeConfig(
  env: Environment = process.env,
): Phase48_2RuntimeConfig {
  return {
    phase48_1: loadPhase48_1RuntimeConfig(env),
    repositoryAuthorization: loadRepositoryAuthorizationConfiguration(
      env.AGENT_RUNNER_REPOSITORY_CONFIG,
    ),
  };
}

export function createPhase48_2ProductionRuntime(input: {
  readonly config: Phase48_2RuntimeConfig;
  readonly startupReconciler: StartupReconciler;
  readonly exactSourceResolvedHandler: ExactSourceResolvedHandler;
  readonly environment?: Environment;
  readonly fetchImpl?: typeof fetch;
  readonly gitRunner?: GitCommandRunner;
}): Phase48_2ProductionRuntime {
  const environment = input.environment ?? process.env;
  const policy = new RepositoryAccessPolicy(input.config.repositoryAuthorization);
  const repository = new GitCliRepositoryComponent({
    policy,
    credentialProvider: new EnvironmentRepositoryCredentialProvider(environment),
    ...(input.gitRunner === undefined ? {} : { gitRunner: input.gitRunner }),
  });

  const redmineClient = new RedmineRestClient({
    baseUrl: input.config.phase48_1.redmine.baseUrl,
    readApiKey: input.config.phase48_1.redmine.readApiKey,
    writeApiKey: input.config.phase48_1.redmine.writeApiKey,
    timeoutMs: input.config.phase48_1.redmine.timeoutMs,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  const rejectionWriter = new RedminePreExecutionRejectionWriter({
    client: redmineClient,
    allowedProjectIds: input.config.phase48_1.controller.allowedProjectIds,
    secretValues: [
      input.config.phase48_1.redmine.readApiKey,
      input.config.phase48_1.redmine.writeApiKey,
    ],
  });

  const eligibleCandidateHandler = new Phase48_2EligibleCandidateHandler({
    repository,
    rejectionWriter,
    next: input.exactSourceResolvedHandler,
  });

  return {
    controller: createPhase48_1ProductionController({
      config: input.config.phase48_1,
      startupReconciler: input.startupReconciler,
      eligibleCandidateHandler,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    }),
    repository,
  };
}
