import {
  buildPhase49ArtifactFromDevelopmentHandoff,
  type Phase49ArtifactFailureReason,
  type Phase49BuiltArtifact,
  type Phase49DevelopmentHandoffInput,
} from "./contract.js";
import { buildPhase49NoChangesArtifact } from "./no-changes.js";
import type { Phase49PersistedArtifact } from "./s3-persistence.js";
import type {
  Phase49ArtifactFailureFinalizationResult,
  Phase49SuccessfulFinalizationResult,
} from "../redmine/phase49-finalizer.js";

export interface Phase49ConfirmedArtifactPersistence {
  persistAndConfirm(artifact: Phase49BuiltArtifact): Promise<Phase49PersistedArtifact>;
}

export interface Phase49ExecutionFinalizationPort {
  finalizeSuccess(input: {
    readonly artifact: Phase49BuiltArtifact;
    readonly persisted: Phase49PersistedArtifact;
  }): Promise<Phase49SuccessfulFinalizationResult>;
  finalizeArtifactFailure(input: {
    readonly handoff: Phase49DevelopmentHandoffInput;
    readonly reason: Phase49ArtifactFailureReason;
  }): Promise<Phase49ArtifactFailureFinalizationResult>;
}

export type Phase49FinalizationResult =
  | {
      readonly kind: "ready_for_independent_verification";
      readonly redmine: Phase49SuccessfulFinalizationResult;
      readonly persisted: Phase49PersistedArtifact;
    }
  | {
      readonly kind: "artifact_failure";
      readonly redmine: Phase49ArtifactFailureFinalizationResult;
    };

/**
 * Owns the Phase 49-4 success ordering. Redmine success is unreachable until
 * the ordinary Phase 49 persistence port has returned a checksum/metadata-
 * confirmed durable artifact reference.
 */
export class Phase49SuccessfulFinalizationCoordinator {
  readonly #persistence: Phase49ConfirmedArtifactPersistence;
  readonly #finalizer: Phase49ExecutionFinalizationPort;

  constructor(input: {
    readonly persistence: Phase49ConfirmedArtifactPersistence;
    readonly finalizer: Phase49ExecutionFinalizationPort;
  }) {
    this.#persistence = input.persistence;
    this.#finalizer = input.finalizer;
  }

  async finalize(
    handoff: Phase49DevelopmentHandoffInput,
  ): Promise<Phase49FinalizationResult> {
    let artifact: Phase49BuiltArtifact;
    try {
      artifact = handoff.provisionalOutcome === "no_changes"
        ? buildPhase49NoChangesArtifact(handoff)
        : buildPhase49ArtifactFromDevelopmentHandoff(handoff);
    } catch {
      const redmine = await this.#finalizer.finalizeArtifactFailure({
        handoff,
        reason: "result_validation_failure",
      });
      return Object.freeze({ kind: "artifact_failure", redmine });
    }

    let persisted: Phase49PersistedArtifact;
    try {
      // Phase49S3ArtifactPersistence performs direct conditional PutObject and
      // checksum-enabled HeadObject confirmation. Missing/mismatched required
      // verification data must reject before this promise resolves.
      persisted = await this.#persistence.persistAndConfirm(artifact);
    } catch {
      const redmine = await this.#finalizer.finalizeArtifactFailure({
        handoff,
        reason: "storage_failure",
      });
      return Object.freeze({ kind: "artifact_failure", redmine });
    }

    // Deliberately outside the artifact-failure catch. At this point a valid
    // durable artifact exists. An unconfirmed Redmine write is therefore not an
    // artifact failure and must be left for Phase 49-5 reconciliation. No Agent
    // retry and no second success/failure mutation are attempted here.
    const redmine = await this.#finalizer.finalizeSuccess({ artifact, persisted });
    return Object.freeze({
      kind: "ready_for_independent_verification",
      redmine,
      persisted,
    });
  }
}
