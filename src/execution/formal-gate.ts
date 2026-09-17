import { RepositoryAccessError } from "../repository/types.js";
import { RepositoryAccessPolicy } from "../repository/policy.js";
import type {
  FormalAuthorizationGate,
  FormalAuthorizationInput,
} from "./types.js";

const FULL_GIT_OID_PATTERN = /^[0-9a-f]{40,128}$/u;

export class Phase47FormalAuthorizationGate implements FormalAuthorizationGate {
  readonly #policy: RepositoryAccessPolicy;

  constructor(policy: RepositoryAccessPolicy) {
    this.#policy = policy;
  }

  authorize(input: FormalAuthorizationInput): Promise<void> {
    return Promise.resolve().then(() => {
      // Formal authorization consumes the unchanged Phase 46 repository identity
      // and the already-fixed exact source revision. It never resolves a mutable
      // source ref and never obtains repository credentials.
      this.#policy.authorize(input.repository);
      if (!FULL_GIT_OID_PATTERN.test(input.sourceRevision)) {
        throw new RepositoryAccessError(
          "source_resolution_failed",
          "formal authorization requires an exact lowercase Git object ID",
        );
      }
    });
  }
}
