import type {
  AgentAdapter,
  CodexOneShotRunner,
  StartedExecutionFailureFinalizer,
  WorkingTreeChangeDetector,
} from "../agent/types.js";
import { AwsSdkPhase49S3ObjectClient } from "../artifact/aws-s3-client.js";
import { Phase49SuccessfulFinalizationCoordinator } from "../artifact/phase49-finalization.js";
import { Phase49ProvisionalResultHandler } from "../artifact/phase49-provisional-handler.js";
import {
  Phase49S3ArtifactPersistence,
  loadPhase49S3RuntimeConfig,
  type Phase49S3ObjectClient,
  type Phase49S3RuntimeConfig,
} from "../artifact/s3-persistence.js";
import {
  GitDevelopmentChangeSetCollector,
  type DevelopmentChangeSetCollector,
} from "../development/change-set.js";
import type { ExecutionIdAllocator } from "../execution/types.js";
import { RedmineInterruptedExecutionFinalizer } from "../redmine/interrupted-finalizer.js";
import { RedminePhase49ExecutionFinalizer } from "../redmine/phase49-finalizer.js";
import { RedmineRestClient } from "../redmine/rest-client.js";
import { Phase49ArtifactAwareExecutionReconciler } from "../recovery/phase49-artifact-reconciler.js";
import type {
  InterruptedExecutionFinalizer,
  OrphanRuntimeCleaner,
  RecoveryDiagnosticSink,
} from "../recovery/types.js";
import type { GitCommandRunner } from "../repository/git-repository.js";
import type { DockerCommandRunner } from "../sandbox/docker-runtime.js";
import type { Redactor } from "../security/redaction.js";
import {
  createPhase48_6ProductionRuntime,
  loadPhase48_6RuntimeConfig,
  type Phase48_6ProductionRuntime,
  type Phase48_6RuntimeConfig,
} from "./phase48-6-runtime.js";

const DEFAULT_PHASE49_PATCH_CAPTURE_BYTES = 4 * 1024 * 1024;

type Environment = Readonly<Record<string, string | undefined>>;

export interface Phase49_5RuntimeConfig {
  readonly phase48_6: Phase48_6RuntimeConfig;
  readonly artifactS3: Phase49S3RuntimeConfig;
  readonly patchCaptureBytes: number;
}

export interface Phase49_5ProductionRuntime {
  readonly controller: Phase48_6ProductionRuntime["controller"];
  readonly repository: Phase48_6ProductionRuntime["repository"];
  readonly sandboxConfig: Phase48_6ProductionRuntime["sandboxConfig"];
  readonly startupReconciler: Phase48_6ProductionRuntime["startupReconciler"];
  readonly artifactPersistence: Phase49S3ArtifactPersistence;
}

export function loadPhase49_5RuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): Phase49_5RuntimeConfig {
  return Object.freeze({
    phase48_6: loadPhase48_6RuntimeConfig(env),
    artifactS3: loadPhase49S3RuntimeConfig(env),
    patchCaptureBytes: parsePositiveIntegerWithDefault(
      env.AGENT_RUNNER_PHASE49_PATCH_CAPTURE_BYTES,
      DEFAULT_PHASE49_PATCH_CAPTURE_BYTES,
      "AGENT_RUNNER_PHASE49_PATCH_CAPTURE_BYTES",
    ),
  });
}

export function createPhase49_5ProductionRuntime(input: {
  readonly config: Phase49_5RuntimeConfig;
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
  readonly orphanCleaner?: OrphanRuntimeCleaner;
  readonly recoveryDiagnosticSink?: RecoveryDiagnosticSink;
  readonly developmentChangeSetCollector?: DevelopmentChangeSetCollector;
  readonly artifactClient?: Phase49S3ObjectClient;
  readonly absentArtifactFinalizer?: InterruptedExecutionFinalizer;
}): Phase49_5ProductionRuntime {
  const environment = input.environment ?? process.env;
  const phase48_1 = input.config.phase48_6.phase48_5.phase48_4.phase48_3.phase48_2.phase48_1;
  const redmineClient = new RedmineRestClient({
    baseUrl: phase48_1.redmine.baseUrl,
    readApiKey: phase48_1.redmine.readApiKey,
    writeApiKey: phase48_1.redmine.writeApiKey,
    timeoutMs: phase48_1.redmine.timeoutMs,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  const artifactClient = input.artifactClient ?? new AwsSdkPhase49S3ObjectClient({
    config: input.config.artifactS3,
  });
  const artifactPersistence = new Phase49S3ArtifactPersistence({
    client: artifactClient,
    config: input.config.artifactS3,
  });
  const finalizer = new RedminePhase49ExecutionFinalizer({
    client: redmineClient,
    allowedProjectIds: phase48_1.controller.allowedProjectIds,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const finalization = new Phase49SuccessfulFinalizationCoordinator({
    persistence: artifactPersistence,
    finalizer,
  });
  const provisionalResultHandler = new Phase49ProvisionalResultHandler({
    collector: input.developmentChangeSetCollector ?? new GitDevelopmentChangeSetCollector({
      patchCaptureBytes: input.config.patchCaptureBytes,
    }),
    finalization,
  });
  const absentArtifactFinalizer = input.absentArtifactFinalizer ??
    new RedmineInterruptedExecutionFinalizer({
      client: redmineClient,
      allowedProjectIds: phase48_1.controller.allowedProjectIds,
      ...(input.clock === undefined ? {} : { clock: input.clock }),
    });
  const artifactAwareFinalizer = new Phase49ArtifactAwareExecutionReconciler({
    reader: redmineClient,
    allowedProjectIds: phase48_1.controller.allowedProjectIds,
    recovery: artifactPersistence,
    successFinalizer: finalizer,
    absentArtifactFinalizer,
  });

  const runtime = createPhase48_6ProductionRuntime({
    config: input.config.phase48_6,
    provisionalResultHandler,
    environment,
    interruptedFinalizer: artifactAwareFinalizer,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.gitRunner === undefined ? {} : { gitRunner: input.gitRunner }),
    ...(input.dockerRunner === undefined ? {} : { dockerRunner: input.dockerRunner }),
    ...(input.executionIdAllocator === undefined
      ? {}
      : { executionIdAllocator: input.executionIdAllocator }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.agentAdapter === undefined ? {} : { agentAdapter: input.agentAdapter }),
    ...(input.codexRunner === undefined ? {} : { codexRunner: input.codexRunner }),
    ...(input.changeDetector === undefined ? {} : { changeDetector: input.changeDetector }),
    ...(input.redactor === undefined ? {} : { redactor: input.redactor }),
    ...(input.failureFinalizer === undefined
      ? {}
      : { failureFinalizer: input.failureFinalizer }),
    ...(input.orphanCleaner === undefined ? {} : { orphanCleaner: input.orphanCleaner }),
    ...(input.recoveryDiagnosticSink === undefined
      ? {}
      : { recoveryDiagnosticSink: input.recoveryDiagnosticSink }),
  });

  return Object.freeze({
    controller: runtime.controller,
    repository: runtime.repository,
    sandboxConfig: runtime.sandboxConfig,
    startupReconciler: runtime.startupReconciler,
    artifactPersistence,
  });
}

function parsePositiveIntegerWithDefault(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}
