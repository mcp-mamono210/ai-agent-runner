import type { AgentController } from "./controller.js";
import {
  createPhase48_5ProductionRuntime,
  loadPhase48_5RuntimeConfig,
  type Phase48_5ProductionRuntime,
  type Phase48_5RuntimeConfig,
} from "./phase48-5-runtime.js";
import type {
  AgentAdapter,
  CodexOneShotRunner,
  ProvisionalAgentResultHandler,
  StartedExecutionFailureFinalizer,
  WorkingTreeChangeDetector,
} from "../agent/types.js";
import type { ExecutionIdAllocator } from "../execution/types.js";
import { RedmineInterruptedExecutionFinalizer } from "../redmine/interrupted-finalizer.js";
import { RedmineRestClient } from "../redmine/rest-client.js";
import { RedmineAgentRunningExecutionSource } from "../recovery/redmine-source.js";
import { DockerWorkspaceOrphanCleaner } from "../recovery/orphan-cleanup.js";
import { Phase48_6StartupReconciler } from "../recovery/startup-reconciler.js";
import type {
  InterruptedExecutionFinalizer,
  OrphanRuntimeCleaner,
  RecoveryDiagnosticSink,
} from "../recovery/types.js";
import type { GitCommandRunner } from "../repository/git-repository.js";
import type { RepositoryAuthorizationConfiguration } from "../repository/types.js";
import {
  NodeDockerCommandRunner,
  type DockerCommandRunner,
} from "../sandbox/docker-runtime.js";
import {
  collectKnownSecretValues,
  KnownSecretRedactor,
  type Redactor,
} from "../security/redaction.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface Phase48_6RuntimeConfig {
  readonly phase48_5: Phase48_5RuntimeConfig;
  readonly executionLifecycleFieldId: number;
}

export interface Phase48_6ProductionRuntime {
  readonly controller: AgentController;
  readonly repository: Phase48_5ProductionRuntime["repository"];
  readonly sandboxConfig: Phase48_5ProductionRuntime["sandboxConfig"];
  readonly startupReconciler: Phase48_6StartupReconciler;
}

export function loadPhase48_6RuntimeConfig(
  env: Environment = process.env,
): Phase48_6RuntimeConfig {
  return Object.freeze({
    phase48_5: loadPhase48_5RuntimeConfig(env),
    executionLifecycleFieldId: requiredPositiveInteger(
      env.AGENT_RUNNER_EXECUTION_LIFECYCLE_FIELD_ID,
      "AGENT_RUNNER_EXECUTION_LIFECYCLE_FIELD_ID",
    ),
  });
}

export function createPhase48_6ProductionRuntime(input: {
  readonly config: Phase48_6RuntimeConfig;
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
  readonly interruptedFinalizer?: InterruptedExecutionFinalizer;
  readonly orphanCleaner?: OrphanRuntimeCleaner;
  readonly recoveryDiagnosticSink?: RecoveryDiagnosticSink;
}): Phase48_6ProductionRuntime {
  const environment = input.environment ?? process.env;
  const phase48_1 = input.config.phase48_5.phase48_4.phase48_3.phase48_2.phase48_1;
  const dockerRunner = input.dockerRunner ?? new NodeDockerCommandRunner();
  const redactor = input.redactor ?? createRecoveryRedactor({
    config: input.config.phase48_5,
    environment,
  });
  const redmineClient = new RedmineRestClient({
    baseUrl: phase48_1.redmine.baseUrl,
    readApiKey: phase48_1.redmine.readApiKey,
    writeApiKey: phase48_1.redmine.writeApiKey,
    timeoutMs: phase48_1.redmine.timeoutMs,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  const source = new RedmineAgentRunningExecutionSource({
    client: redmineClient,
    allowedProjectIds: phase48_1.controller.allowedProjectIds,
    executionLifecycleFieldId: input.config.executionLifecycleFieldId,
  });
  const finalizer = input.interruptedFinalizer ?? new RedmineInterruptedExecutionFinalizer({
    client: redmineClient,
    allowedProjectIds: phase48_1.controller.allowedProjectIds,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const cleaner = input.orphanCleaner ?? new DockerWorkspaceOrphanCleaner({
    docker: dockerRunner,
    workspaceRoot: input.config.phase48_5.phase48_4.sandbox.workspaceRoot,
  });
  const startupReconciler = new Phase48_6StartupReconciler({
    source,
    cleaner,
    finalizer,
    redactor,
    ...(input.recoveryDiagnosticSink === undefined
      ? {}
      : { diagnosticSink: input.recoveryDiagnosticSink }),
  });

  const runtime = createPhase48_5ProductionRuntime({
    config: input.config.phase48_5,
    startupReconciler,
    provisionalResultHandler: input.provisionalResultHandler,
    environment,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.gitRunner === undefined ? {} : { gitRunner: input.gitRunner }),
    dockerRunner,
    ...(input.executionIdAllocator === undefined
      ? {}
      : { executionIdAllocator: input.executionIdAllocator }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.agentAdapter === undefined ? {} : { agentAdapter: input.agentAdapter }),
    ...(input.codexRunner === undefined ? {} : { codexRunner: input.codexRunner }),
    ...(input.changeDetector === undefined ? {} : { changeDetector: input.changeDetector }),
    redactor,
    ...(input.failureFinalizer === undefined
      ? {}
      : { failureFinalizer: input.failureFinalizer }),
  });

  return Object.freeze({
    controller: runtime.controller,
    repository: runtime.repository,
    sandboxConfig: runtime.sandboxConfig,
    startupReconciler,
  });
}

function createRecoveryRedactor(input: {
  readonly config: Phase48_5RuntimeConfig;
  readonly environment: Environment;
}): Redactor {
  const phase48_1 = input.config.phase48_4.phase48_3.phase48_2.phase48_1;
  const repositoryAuthorization = input.config.phase48_4.phase48_3.phase48_2.repositoryAuthorization;
  const providerKey = input.environment.AGENT_RUNNER_CODEX_API_KEY;
  return new KnownSecretRedactor(
    collectKnownSecretValues({
      environment: input.environment,
      requiredValues: [
        phase48_1.redmine.readApiKey,
        phase48_1.redmine.writeApiKey,
        ...(providerKey === undefined ? [] : [providerKey]),
      ],
      secretEnvironmentNames: collectSecretEnvironmentNames(
        repositoryAuthorization,
        input.config.redactionSecretEnvironmentNames,
      ),
    }),
  );
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

function requiredPositiveInteger(value: string | undefined, name: string): number {
  if (value === undefined || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}
