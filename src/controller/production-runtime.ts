import {
  LocalGitApprovedBriefVerifier,
  Phase46HandoffValidator,
} from "../agent-brief/handoff-binding.js";
import { CanonicalRequirementsRevalidator } from "../agent-brief/requirements-binding.js";
import { RedmineCandidateSource, RedmineIssueReader } from "../redmine/adapters.js";
import { RedminePreExecutionRejectionWriter } from "../redmine/rejection-writer.js";
import { RedmineRestClient } from "../redmine/rest-client.js";
import {
  loadControllerConfig,
  type ControllerConfig,
} from "./config.js";
import type {
  EligibleCandidateHandler,
  StartupReconciler,
} from "./types.js";
import { createAgentController } from "./runtime.js";
import type { AgentController } from "./controller.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface Phase48_1RuntimeConfig {
  readonly controller: ControllerConfig;
  readonly redmine: {
    readonly baseUrl: string;
    readonly readApiKey: string;
    readonly writeApiKey: string;
    readonly timeoutMs: number;
    readonly lifecycleFieldId: number;
  };
  readonly agentBrief: {
    readonly repositoryRoot: string;
    readonly repository: string;
    readonly canonicalBranch: string;
    readonly requirementCustomFieldIds: readonly number[];
  };
}

export function loadPhase48_1RuntimeConfig(
  env: Environment = process.env,
): Phase48_1RuntimeConfig {
  return {
    controller: loadControllerConfig(env),
    redmine: {
      baseUrl: requireNonBlank(env, "REDMINE_URL"),
      readApiKey: requireNonBlank(env, "REDMINE_API_KEY"),
      writeApiKey: requireNonBlank(env, "REDMINE_WRITE_API_KEY"),
      timeoutMs: parsePositiveInteger(env.REDMINE_TIMEOUT_MS, 10_000, "REDMINE_TIMEOUT_MS"),
      lifecycleFieldId: parseRequiredPositiveInteger(
        env.AGENT_RUNNER_BRIEF_LIFECYCLE_FIELD_ID,
        "AGENT_RUNNER_BRIEF_LIFECYCLE_FIELD_ID",
      ),
    },
    agentBrief: {
      repositoryRoot: requireNonBlank(env, "AGENT_BRIEF_REPOSITORY_ROOT"),
      repository: requireNonBlank(env, "AGENT_BRIEF_REPOSITORY"),
      canonicalBranch: env.AGENT_BRIEF_CANONICAL_BRANCH?.trim() || "main",
      requirementCustomFieldIds: parsePositiveIntegerList(
        env.AGENT_BRIEF_REQUIREMENT_CUSTOM_FIELD_IDS,
        "AGENT_BRIEF_REQUIREMENT_CUSTOM_FIELD_IDS",
      ),
    },
  };
}

/**
 * Production Phase 48-1 composition root.
 *
 * Later phases provide only the responsibilities they own:
 * - startupReconciler: Phase 48-6
 * - eligibleCandidateHandler: Phase 48-2 onward
 *
 * Redmine polling/re-fetch, Phase 46 handoff validation, Phase 39 requirements
 * revalidation, and pre-execution rejection writes are concrete here.
 */
export function createPhase48_1ProductionController(input: {
  readonly config: Phase48_1RuntimeConfig;
  readonly startupReconciler: StartupReconciler;
  readonly eligibleCandidateHandler: EligibleCandidateHandler;
  readonly fetchImpl?: typeof fetch;
}): AgentController {
  const client = new RedmineRestClient({
    baseUrl: input.config.redmine.baseUrl,
    readApiKey: input.config.redmine.readApiKey,
    writeApiKey: input.config.redmine.writeApiKey,
    timeoutMs: input.config.redmine.timeoutMs,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });

  const approvedBriefVerifier = new LocalGitApprovedBriefVerifier({
    repositoryRoot: input.config.agentBrief.repositoryRoot,
    repository: input.config.agentBrief.repository,
    canonicalBranch: input.config.agentBrief.canonicalBranch,
  });

  return createAgentController(input.config.controller, {
    candidateSource: new RedmineCandidateSource(client, {
      lifecycleFieldId: input.config.redmine.lifecycleFieldId,
    }),
    issueReader: new RedmineIssueReader(client),
    handoffValidator: new Phase46HandoffValidator({
      repository: input.config.agentBrief.repository,
      approvedBriefVerifier,
    }),
    requirementsRevalidator: new CanonicalRequirementsRevalidator({
      requirementCustomFieldIds:
        input.config.agentBrief.requirementCustomFieldIds,
    }),
    rejectionWriter: new RedminePreExecutionRejectionWriter({
      client,
      allowedProjectIds: input.config.controller.allowedProjectIds,
      secretValues: [
        input.config.redmine.readApiKey,
        input.config.redmine.writeApiKey,
      ],
    }),
    startupReconciler: input.startupReconciler,
    eligibleCandidateHandler: input.eligibleCandidateHandler,
  });
}

function requireNonBlank(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseRequiredPositiveInteger(
  raw: string | undefined,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return parsePositiveInteger(raw, 0, name);
}

function parsePositiveInteger(
  raw: string | undefined,
  defaultValue: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") {
    if (defaultValue > 0) {
      return defaultValue;
    }
    throw new Error(`${name} is required`);
  }
  if (!/^[1-9]\d*$/u.test(raw.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function parsePositiveIntegerList(
  raw: string | undefined,
  name: string,
): readonly number[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const values = parts.map((part) => parsePositiveInteger(part, 0, name));
  return [...new Set(values)].sort((left, right) => left - right);
}
