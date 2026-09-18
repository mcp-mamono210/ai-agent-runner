import type { AgentController } from "./controller.js";
import {
  createPhase48_4ProductionRuntime,
  loadPhase48_4RuntimeConfig,
  type Phase48_4ProductionRuntime,
  type Phase48_4RuntimeConfig,
} from "./phase48-4-runtime.js";
import type { StartupReconciler } from "./types.js";
import {
  CodexCliAgentAdapter,
  DockerCodexOneShotRunner,
  EnvironmentCodexProviderCredentialProvider,
  GitWorkingTreeChangeDetector,
} from "../agent/codex-cli-adapter.js";
import {
  Phase48_5SandboxPreparationFailureHandler,
  Phase48_5SandboxPreparedHandler,
} from "../agent/phase48-5-handler.js";
import type {
  AgentAdapter,
  CodexOneShotRunner,
  ProvisionalAgentResultHandler,
  StartedExecutionFailureFinalizer,
  WorkingTreeChangeDetector,
} from "../agent/types.js";
import type { ExecutionIdAllocator } from "../execution/types.js";
import { RedmineStartedExecutionFailureFinalizer } from "../redmine/execution-finalizer.js";
import { RedmineRestClient } from "../redmine/rest-client.js";
import type { GitCommandRunner } from "../repository/git-repository.js";
import type { RepositoryAuthorizationConfiguration } from "../repository/types.js";
import type { DockerCommandRunner } from "../sandbox/docker-runtime.js";
import { collectKnownSecretValues, KnownSecretRedactor, type Redactor } from "../security/redaction.js";

type Environment = Readonly<Record<string, string | undefined>>;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

export interface Phase48_5RuntimeConfig {
  readonly phase48_4: Phase48_4RuntimeConfig;
  readonly redactionSecretEnvironmentNames: readonly string[];
}

export interface Phase48_5ProductionRuntime {
  readonly controller: AgentController;
  readonly repository: Phase48_4ProductionRuntime["repository"];
  readonly sandboxConfig: Phase48_4ProductionRuntime["sandboxConfig"];
}

export function loadPhase48_5RuntimeConfig(
  env: Environment = process.env,
): Phase48_5RuntimeConfig {
  return Object.freeze({
    phase48_4: loadPhase48_4RuntimeConfig(env),
    redactionSecretEnvironmentNames: parseSecretEnvironmentNames(
      env.AGENT_RUNNER_REDACTION_SECRET_ENV_NAMES,
    ),
  });
}

export function createPhase48_5ProductionRuntime(input: {
  readonly config: Phase48_5RuntimeConfig;
  readonly startupReconciler: StartupReconciler;
  readonly provisionalResultHandler: ProvisionalAgentResultHandler;
  readonly environment?: Environment;
  readonly fetchImpl?: typeof fetch;
  readonly gitRunner?: GitCommandRunner;
  readonly dockerRunner?: DockerCommandRunner;
  readonly executionIdAllocator?: ExecutionIdAllocator;
  readonly clock?: () => Date;
  readonly agentAdapter?: AgentAdapter;
  readonly codexRunner?: CodexOneShotRunner;
  readonly changeDetector?: WorkingTreeChangeDetector;
  readonly redactor?: Redactor;
  readonly failureFinalizer?: StartedExecutionFailureFinalizer;
}): Phase48_5ProductionRuntime {
  const environment = input.environment ?? process.env;
  const phase48_1 = input.config.phase48_4.phase48_3.phase48_2.phase48_1;
  const redmineClient = new RedmineRestClient({
    baseUrl: phase48_1.redmine.baseUrl,
    readApiKey: phase48_1.redmine.readApiKey,
    writeApiKey: phase48_1.redmine.writeApiKey,
    timeoutMs: phase48_1.redmine.timeoutMs,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  const failureFinalizer = input.failureFinalizer ?? new RedmineStartedExecutionFailureFinalizer({
    client: redmineClient,
    allowedProjectIds: phase48_1.controller.allowedProjectIds,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });

  const agentAdapter = input.agentAdapter ?? createDefaultAgentAdapter({
    config: input.config,
    environment,
    ...(input.dockerRunner === undefined ? {} : { dockerRunner: input.dockerRunner }),
    ...(input.codexRunner === undefined ? {} : { codexRunner: input.codexRunner }),
    ...(input.changeDetector === undefined ? {} : { changeDetector: input.changeDetector }),
    ...(input.redactor === undefined ? {} : { redactor: input.redactor }),
  });
  const sandboxPreparedHandler = new Phase48_5SandboxPreparedHandler({
    agentAdapter,
    failureFinalizer,
    provisionalResultHandler: input.provisionalResultHandler,
  });
  const preAgentFailureHandler = new Phase48_5SandboxPreparationFailureHandler(
    failureFinalizer,
  );

  return createPhase48_4ProductionRuntime({
    config: input.config.phase48_4,
    startupReconciler: input.startupReconciler,
    sandboxPreparedHandler,
    preAgentFailureHandler,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.gitRunner === undefined ? {} : { gitRunner: input.gitRunner }),
    ...(input.dockerRunner === undefined ? {} : { dockerRunner: input.dockerRunner }),
    ...(input.executionIdAllocator === undefined
      ? {}
      : { executionIdAllocator: input.executionIdAllocator }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
}

function createDefaultAgentAdapter(input: {
  readonly config: Phase48_5RuntimeConfig;
  readonly environment: Environment;
  readonly dockerRunner?: DockerCommandRunner;
  readonly codexRunner?: CodexOneShotRunner;
  readonly changeDetector?: WorkingTreeChangeDetector;
  readonly redactor?: Redactor;
}): AgentAdapter {
  const credentialProvider = new EnvironmentCodexProviderCredentialProvider(input.environment);
  const credential = credentialProvider.getCredential();
  const redactor = input.redactor ?? new KnownSecretRedactor(
    collectKnownSecretValues({
      environment: input.environment,
      requiredValues: [
        input.config.phase48_4.phase48_3.phase48_2.phase48_1.redmine.readApiKey,
        input.config.phase48_4.phase48_3.phase48_2.phase48_1.redmine.writeApiKey,
        credential.apiKey,
      ],
      secretEnvironmentNames: collectSecretEnvironmentNames(
        input.config.phase48_4.phase48_3.phase48_2.repositoryAuthorization,
        input.config.redactionSecretEnvironmentNames,
      ),
    }),
  );
  return new CodexCliAgentAdapter({
    credentialProvider,
    runner: input.codexRunner ?? new DockerCodexOneShotRunner(input.dockerRunner),
    changeDetector: input.changeDetector ?? new GitWorkingTreeChangeDetector(),
    redactor,
  });
}

function collectSecretEnvironmentNames(
  repositoryAuthorization: RepositoryAuthorizationConfiguration,
  additional: readonly string[],
): readonly string[] {
  const names = new Set<string>(["CONTROL_PLANE_API_KEY", ...additional]);
  if (repositoryAuthorization.kind === "configured") {
    for (const entry of repositoryAuthorization.entries) {
      names.add(entry.usernameEnv);
      names.add(entry.passwordEnv);
    }
  }
  return Object.freeze([...names]);
}

export function parseSecretEnvironmentNames(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") {
    return Object.freeze([]);
  }
  const names = raw.split(",").map((entry) => entry.trim());
  if (names.some((name) => !ENV_NAME_PATTERN.test(name))) {
    throw new Error("AGENT_RUNNER_REDACTION_SECRET_ENV_NAMES contains an invalid environment name");
  }
  if (new Set(names).size !== names.length) {
    throw new Error("AGENT_RUNNER_REDACTION_SECRET_ENV_NAMES contains duplicates");
  }
  return Object.freeze(names);
}
