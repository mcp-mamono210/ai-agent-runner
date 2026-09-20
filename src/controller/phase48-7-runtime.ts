import type { AgentAdapter, CodexOneShotRunner, StartedExecutionFailureFinalizer, WorkingTreeChangeDetector } from "../agent/types.js";
import type { ExecutionIdAllocator } from "../execution/types.js";
import { GitDevelopmentChangeSetCollector, type DevelopmentChangeSetCollector } from "../development/change-set.js";
import {
  InMemoryDevelopmentPhase49HandoffStore,
  Phase48_7ProvisionalResultHandler,
} from "../development/phase49-handoff.js";
import {
  Phase48DevelopmentWalkingSkeleton,
  type DevelopmentFixtureReset,
} from "../development/walking-skeleton.js";
import type { InterruptedExecutionFinalizer, OrphanRuntimeCleaner, RecoveryDiagnosticSink } from "../recovery/types.js";
import type { GitCommandRunner } from "../repository/git-repository.js";
import type { DockerCommandRunner } from "../sandbox/docker-runtime.js";
import type { Redactor } from "../security/redaction.js";
import {
  createPhase48_6ProductionRuntime,
  loadPhase48_6RuntimeConfig,
  type Phase48_6ProductionRuntime,
  type Phase48_6RuntimeConfig,
} from "./phase48-6-runtime.js";

const DEFAULT_PATCH_CAPTURE_BYTES = 4 * 1024 * 1024;
const DEFAULT_SUMMARY_CAPTURE_BYTES = 64 * 1024;

type Environment = Readonly<Record<string, string | undefined>>;

export interface Phase48_7DevelopmentRuntimeConfig {
  readonly phase48_6: Phase48_6RuntimeConfig;
  readonly patchCaptureBytes: number;
  readonly summaryCaptureBytes: number;
}

export interface Phase48_7DevelopmentRuntime {
  readonly controller: Phase48_6ProductionRuntime["controller"];
  readonly repository: Phase48_6ProductionRuntime["repository"];
  readonly sandboxConfig: Phase48_6ProductionRuntime["sandboxConfig"];
  readonly startupReconciler: Phase48_6ProductionRuntime["startupReconciler"];
  readonly handoffStore: InMemoryDevelopmentPhase49HandoffStore;
  readonly walkingSkeleton: Phase48DevelopmentWalkingSkeleton;
}

export function loadPhase48_7DevelopmentRuntimeConfig(
  env: Environment = process.env,
): Phase48_7DevelopmentRuntimeConfig {
  return Object.freeze({
    phase48_6: loadPhase48_6RuntimeConfig(env),
    patchCaptureBytes: parsePositiveIntegerWithDefault(
      env.AGENT_RUNNER_DEVELOPMENT_PATCH_CAPTURE_BYTES,
      DEFAULT_PATCH_CAPTURE_BYTES,
      "AGENT_RUNNER_DEVELOPMENT_PATCH_CAPTURE_BYTES",
    ),
    summaryCaptureBytes: parsePositiveIntegerWithDefault(
      env.AGENT_RUNNER_DEVELOPMENT_SUMMARY_CAPTURE_BYTES,
      DEFAULT_SUMMARY_CAPTURE_BYTES,
      "AGENT_RUNNER_DEVELOPMENT_SUMMARY_CAPTURE_BYTES",
    ),
  });
}

export function createPhase48_7DevelopmentRuntime(input: {
  readonly config: Phase48_7DevelopmentRuntimeConfig;
  readonly fixtureReset: DevelopmentFixtureReset;
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
  readonly developmentChangeSetCollector?: DevelopmentChangeSetCollector;
}): Phase48_7DevelopmentRuntime {
  const handoffStore = new InMemoryDevelopmentPhase49HandoffStore();
  const provisionalResultHandler = new Phase48_7ProvisionalResultHandler({
    collector: input.developmentChangeSetCollector ?? new GitDevelopmentChangeSetCollector({
      patchCaptureBytes: input.config.patchCaptureBytes,
    }),
    sink: handoffStore,
    summaryCaptureBytes: input.config.summaryCaptureBytes,
  });

  const runtime = createPhase48_6ProductionRuntime({
    config: input.config.phase48_6,
    provisionalResultHandler,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.gitRunner === undefined ? {} : { gitRunner: input.gitRunner }),
    ...(input.dockerRunner === undefined ? {} : { dockerRunner: input.dockerRunner }),
    ...(input.executionIdAllocator === undefined ? {} : { executionIdAllocator: input.executionIdAllocator }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.agentAdapter === undefined ? {} : { agentAdapter: input.agentAdapter }),
    ...(input.codexRunner === undefined ? {} : { codexRunner: input.codexRunner }),
    ...(input.changeDetector === undefined ? {} : { changeDetector: input.changeDetector }),
    ...(input.redactor === undefined ? {} : { redactor: input.redactor }),
    ...(input.failureFinalizer === undefined ? {} : { failureFinalizer: input.failureFinalizer }),
    ...(input.interruptedFinalizer === undefined ? {} : { interruptedFinalizer: input.interruptedFinalizer }),
    ...(input.orphanCleaner === undefined ? {} : { orphanCleaner: input.orphanCleaner }),
    ...(input.recoveryDiagnosticSink === undefined ? {} : { recoveryDiagnosticSink: input.recoveryDiagnosticSink }),
  });

  return Object.freeze({
    controller: runtime.controller,
    repository: runtime.repository,
    sandboxConfig: runtime.sandboxConfig,
    startupReconciler: runtime.startupReconciler,
    handoffStore,
    walkingSkeleton: new Phase48DevelopmentWalkingSkeleton({
      controller: runtime.controller,
      handoffStore,
      fixtureReset: input.fixtureReset,
    }),
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
