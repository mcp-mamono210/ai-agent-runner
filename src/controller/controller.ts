import type { ControllerConfig } from "./config.js";
import type { LocalIssueLock } from "./local-lock.js";
import {
  READY_FOR_AGENT_LIFECYCLE,
  type CandidateSource,
  type EligibleCandidateHandler,
  type HandoffValidator,
  type IssueReader,
  type PreExecutionRejectionWriter,
  type ReadyForAgentCandidate,
  type RequirementsRevalidator,
  type Sleeper,
  type StartupReconciler,
} from "./types.js";

export interface ControllerDependencies {
  readonly candidateSource: CandidateSource;
  readonly issueReader: IssueReader;
  readonly handoffValidator: HandoffValidator;
  readonly requirementsRevalidator: RequirementsRevalidator;
  readonly rejectionWriter: PreExecutionRejectionWriter;
  readonly startupReconciler: StartupReconciler;
  readonly eligibleCandidateHandler: EligibleCandidateHandler;
  readonly localLock: LocalIssueLock;
  readonly sleeper: Sleeper;
}

/**
 * Phase 48-1 controller entry point.
 *
 * This class stops at the Phase 48-2 handoff. It does not access repositories,
 * allocate execution_id, write Agent Running, create a sandbox, or start an
 * Agent.
 */
export class AgentController {
  readonly #config: ControllerConfig;
  readonly #deps: ControllerDependencies;

  constructor(config: ControllerConfig, dependencies: ControllerDependencies) {
    if (config.allowedProjectIds.length === 0) {
      throw new Error("allowedProjectIds must not be empty");
    }
    if (!Number.isSafeInteger(config.pollIntervalMs) || config.pollIntervalMs <= 0) {
      throw new Error("pollIntervalMs must be a positive integer");
    }

    this.#config = config;
    this.#deps = dependencies;
  }

  /** Startup reconciliation is always completed before the first poll. */
  async run(signal: AbortSignal): Promise<void> {
    await this.#deps.startupReconciler.reconcile();

    while (!signal.aborted) {
      await this.runOnce();
      if (signal.aborted) {
        return;
      }
      await this.#deps.sleeper.sleep(this.#config.pollIntervalMs, signal);
    }
  }

  /**
   * Executes one idle polling cycle. The candidate source is bounded to one
   * Ready-for-Agent candidate, so this controller cannot start multiple units
   * of work in a single cycle.
   */
  async runOnce(): Promise<void> {
    const candidates = await this.#deps.candidateSource.listReadyForAgentCandidates({
      allowedProjectIds: this.#config.allowedProjectIds,
      lifecycle: READY_FOR_AGENT_LIFECYCLE,
      limit: 1,
    });

    const candidate = candidates[0];
    if (candidate === undefined) {
      return;
    }

    await this.#processCandidate(candidate);
  }

  async #processCandidate(candidate: ReadyForAgentCandidate): Promise<void> {
    if (!this.#config.allowedProjectIds.includes(candidate.projectId)) {
      return;
    }

    if (!this.#deps.localLock.tryAcquire(candidate.issueId)) {
      return;
    }

    try {
      const issue = await this.#deps.issueReader.getIssue(candidate.issueId);

      if (
        issue.issueId !== candidate.issueId ||
        issue.projectId !== candidate.projectId ||
        issue.lifecycle !== READY_FOR_AGENT_LIFECYCLE
      ) {
        return;
      }

      const handoffResult = await this.#deps.handoffValidator.validate(issue);
      if (!handoffResult.ok) {
        await this.#deps.rejectionWriter.reject({
          issueId: issue.issueId,
          outcome: "eligibility_failed",
          diagnostic: handoffResult.diagnostic,
        });
        return;
      }

      const requirementsResult = await this.#deps.requirementsRevalidator.revalidate(
        issue,
        handoffResult.handoff,
      );

      switch (requirementsResult.kind) {
        case "current":
          await this.#deps.eligibleCandidateHandler.handle({
            issue,
            handoff: handoffResult.handoff,
            currentRequirementsFingerprint:
              requirementsResult.currentFingerprint,
          });
          return;
        case "stale":
          await this.#deps.rejectionWriter.reject({
            issueId: issue.issueId,
            outcome: "stale_requirements",
            diagnostic:
              requirementsResult.diagnostic ??
              "current requirements fingerprint does not match approved fingerprint",
          });
          return;
        case "failed":
          await this.#deps.rejectionWriter.reject({
            issueId: issue.issueId,
            outcome: "eligibility_failed",
            diagnostic: requirementsResult.diagnostic,
          });
          return;
      }
    } finally {
      this.#deps.localLock.release(candidate.issueId);
    }
  }
}

export class AbortableSleeper implements Sleeper {
  async sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      const abort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
