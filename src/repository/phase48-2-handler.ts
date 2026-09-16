import type {
  EligibleCandidateHandler,
  PreExecutionRejectionWriter,
} from "../controller/types.js";
import {
  RepositoryAccessError,
  type ExactSourceResolvedHandler,
  type RepositorySourceResolver,
  type ResolvedSource,
} from "./types.js";

export class Phase48_2EligibleCandidateHandler implements EligibleCandidateHandler {
  readonly #repository: RepositorySourceResolver;
  readonly #rejectionWriter: PreExecutionRejectionWriter;
  readonly #next: ExactSourceResolvedHandler;

  constructor(input: {
    readonly repository: RepositorySourceResolver;
    readonly rejectionWriter: PreExecutionRejectionWriter;
    readonly next: ExactSourceResolvedHandler;
  }) {
    this.#repository = input.repository;
    this.#rejectionWriter = input.rejectionWriter;
    this.#next = input.next;
  }

  async handle(input: Parameters<EligibleCandidateHandler["handle"]>[0]): Promise<void> {
    let resolved: ResolvedSource;
    try {
      resolved = await this.#repository.resolveExactSource(input.handoff.repository);
    } catch (error) {
      await this.#rejectionWriter.reject({
        issueId: input.issue.issueId,
        outcome: "eligibility_failed",
        diagnostic: sourceResolutionDiagnostic(error),
      });
      return;
    }

    await this.#next.handle({
      issue: input.issue,
      handoff: input.handoff,
      currentRequirementsFingerprint: input.currentRequirementsFingerprint,
      repository: resolved.repository,
      sourceRevision: resolved.sourceRevision,
    });
  }
}

function sourceResolutionDiagnostic(error: unknown): string {
  if (error instanceof RepositoryAccessError) {
    return `repository source preparation failed: ${error.code}`;
  }
  return "repository source preparation failed";
}
