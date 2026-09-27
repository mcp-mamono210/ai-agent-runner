import type { ControllerConfig } from "./config.js";
import type { LocalIssueLock } from "./local-lock.js";
import {
  NoopCandidateDiagnosticSink,
  recordCandidateDiagnostic,
} from "./candidate-diagnostic.js";
import {
  READY_FOR_AGENT_LIFECYCLE,
  type CandidateDiagnosticSink,
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

const PHASE53_CANDIDATE_SCAN_LIMIT = 100;

type CandidateProcessingResult = "skipped" | "consumed";

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
  readonly candidateDiagnosticSink?: CandidateDiagnosticSink;
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
  readonly #candidateDiagnosticSink: CandidateDiagnosticSink;

  constructor(config: ControllerConfig, dependencies: ControllerDependencies) {
    if (config.allowedProjectIds.length === 0) {
      throw new Error("allowedProjectIds must not be empty");
    }
    if (!Number.isSafeInteger(config.pollIntervalMs) || config.pollIntervalMs <= 0) {
      throw new Error("pollIntervalMs must be a positive integer");
    }

    this.#config = config;
    this.#deps = dependencies;
    this.#candidateDiagnosticSink =
      dependencies.candidateDiagnosticSink ?? new NoopCandidateDiagnosticSink();
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
   * Executes one idle polling cycle. Phase 53 scans at most 100 candidates and
   * still permits at most one candidate to cross into rejection/execution work
   * in a single cycle.
   */
  async runOnce(): Promise<void> {
    const candidates = await this.#deps.candidateSource.listReadyForAgentCandidates({
      allowedProjectIds: this.#config.allowedProjectIds,
      lifecycle: READY_FOR_AGENT_LIFECYCLE,
      limit: PHASE53_CANDIDATE_SCAN_LIMIT,
    });

    if (candidates.length > PHASE53_CANDIDATE_SCAN_LIMIT) {
      await recordCandidateDiagnostic(this.#candidateDiagnosticSink, {
        kind: "query_predicate_mismatch",
        reason:
          "candidate list item did not satisfy the requested project and lifecycle predicate",
      });
      throw new Error("candidate polling stopped: candidate source exceeded scan bound");
    }

    for (const candidate of candidates) {
      if (!this.#config.allowedProjectIds.includes(candidate.projectId)) {
        await recordCandidateDiagnostic(this.#candidateDiagnosticSink, {
          kind: "query_predicate_mismatch",
          issueId: candidate.issueId,
          reason:
            "candidate list item did not satisfy the requested project and lifecycle predicate",
        });
        throw new Error("candidate polling stopped: query predicate mismatch");
      }

      const result = await this.#processCandidate(candidate);
      if (result === "consumed") {
        return;
      }
    }

    if (candidates.length === PHASE53_CANDIDATE_SCAN_LIMIT) {
      await recordCandidateDiagnostic(this.#candidateDiagnosticSink, {
        kind: "candidate_scan_exhausted",
        reason: "candidate scan bound reached without an executable candidate",
      });
      throw new Error("candidate polling stopped: candidate scan exhausted");
    }
  }

  async #processCandidate(
    candidate: ReadyForAgentCandidate,
  ): Promise<CandidateProcessingResult> {
    if (!this.#deps.localLock.tryAcquire(candidate.issueId)) {
      return "skipped";
    }

    try {
      const issue = await this.#deps.issueReader.getIssue(candidate.issueId);

      if (issue.issueId !== candidate.issueId) {
        await recordCandidateDiagnostic(this.#candidateDiagnosticSink, {
          kind: "candidate_state_changed",
          issueId: candidate.issueId,
          reason: "post-lock issue identity changed",
        });
        return "skipped";
      }

      if (issue.projectId !== candidate.projectId) {
        await recordCandidateDiagnostic(this.#candidateDiagnosticSink, {
          kind: "unexpected_project",
          issueId: issue.issueId,
          reason: "post-lock issue project changed",
        });
        return "skipped";
      }

      if (issue.lifecycle !== READY_FOR_AGENT_LIFECYCLE) {
        await recordCandidateDiagnostic(this.#candidateDiagnosticSink, {
          kind: "candidate_state_changed",
          issueId: issue.issueId,
          reason: "post-lock brief lifecycle changed",
        });
        return "skipped";
      }

      if (issue.postLockState !== undefined) {
        if (issue.postLockState.executionLifecycle !== "") {
          await recordCandidateDiagnostic(this.#candidateDiagnosticSink, {
            kind: "candidate_state_changed",
            issueId: issue.issueId,
            reason: "post-lock execution lifecycle changed",
          });
          return "skipped";
        }
        if (!issue.postLockState.executionRecordPristine) {
          await recordCandidateDiagnostic(this.#candidateDiagnosticSink, {
            kind: "non_pristine_candidate_skipped",
            issueId: issue.issueId,
            reason: "post-lock execution or rejection record is non-pristine",
          });
          return "skipped";
        }
      }

      const handoffResult = await this.#deps.handoffValidator.validate(issue);
      if (!handoffResult.ok) {
        await this.#deps.rejectionWriter.reject({
          issueId: issue.issueId,
          outcome: "eligibility_failed",
          diagnostic: handoffResult.diagnostic,
        });
        return "consumed";
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
          return "consumed";
        case "stale":
          await this.#deps.rejectionWriter.reject({
            issueId: issue.issueId,
            outcome: "stale_requirements",
            diagnostic:
              requirementsResult.diagnostic ??
              "current requirements fingerprint does not match approved fingerprint",
          });
          return "consumed";
        case "failed":
          await this.#deps.rejectionWriter.reject({
            issueId: issue.issueId,
            outcome: "eligibility_failed",
            diagnostic: requirementsResult.diagnostic,
          });
          return "consumed";
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
