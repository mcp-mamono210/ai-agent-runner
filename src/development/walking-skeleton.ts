import type { AgentController } from "../controller/controller.js";
import type {
  DevelopmentPhase49Handoff,
  InMemoryDevelopmentPhase49HandoffStore,
} from "./phase49-handoff.js";

export interface DevelopmentFixtureReset {
  /**
   * Resets or recreates disposable development fixture state outside the
   * production Agent Controller lifecycle. Implementations must not be used as
   * a production lifecycle transition.
   */
  reset(): Promise<void>;
}

export class Phase48DevelopmentWalkingSkeleton {
  readonly #controller: Pick<AgentController, "runOnce">;
  readonly #handoffStore: InMemoryDevelopmentPhase49HandoffStore;
  readonly #fixtureReset: DevelopmentFixtureReset;

  constructor(input: {
    readonly controller: Pick<AgentController, "runOnce">;
    readonly handoffStore: InMemoryDevelopmentPhase49HandoffStore;
    readonly fixtureReset: DevelopmentFixtureReset;
  }) {
    this.#controller = input.controller;
    this.#handoffStore = input.handoffStore;
    this.#fixtureReset = input.fixtureReset;
  }

  async runOnce(): Promise<DevelopmentPhase49Handoff> {
    this.#handoffStore.clear();
    try {
      await this.#controller.runOnce();
      const handoffs = this.#handoffStore.list();
      if (handoffs.length !== 1) {
        throw new Error(
          `development Walking Skeleton expected exactly one Phase 49 handoff, received ${handoffs.length}`,
        );
      }
      return handoffs[0]!;
    } finally {
      await this.#fixtureReset.reset();
    }
  }
}
