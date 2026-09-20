import type { PreparedExecution } from "../execution/types.js";
import type {
  SandboxDisposalReason,
  SandboxPreparationFailureHandler,
  SandboxPreparedHandler,
} from "../sandbox/types.js";
import type {
  AgentAdapter,
  ProvisionalAgentResultHandler,
  StartedExecutionFailureFinalizer,
} from "./types.js";

export class Phase48_5SandboxPreparedHandler implements SandboxPreparedHandler {
  readonly #agentAdapter: AgentAdapter;
  readonly #failureFinalizer: StartedExecutionFailureFinalizer;
  readonly #provisionalResultHandler: ProvisionalAgentResultHandler;

  constructor(input: {
    readonly agentAdapter: AgentAdapter;
    readonly failureFinalizer: StartedExecutionFailureFinalizer;
    readonly provisionalResultHandler: ProvisionalAgentResultHandler;
  }) {
    this.#agentAdapter = input.agentAdapter;
    this.#failureFinalizer = input.failureFinalizer;
    this.#provisionalResultHandler = input.provisionalResultHandler;
  }

  async handle(input: Parameters<SandboxPreparedHandler["handle"]>[0]): Promise<SandboxDisposalReason> {
    let result;
    try {
      result = await this.#agentAdapter.runAgent({
        workspace: input.workspace,
        sandbox: input.sandbox,
        executionInput: input.execution.input,
      });
    } catch {
      await this.#failureFinalizer.finalizeFailure({
        execution: input.execution,
        outcome: "agent_failed",
      });
      return "failure";
    }

    if (result.kind === "started_failure") {
      await this.#failureFinalizer.finalizeFailure({
        execution: input.execution,
        outcome: result.outcome,
      });
      return result.outcome === "timeout" ? "timeout" : "failure";
    }

    // changes_ready / no_changes are provisional in Phase 48. This continuation
    // must not write Ready for Independent Verification or artifact_reference.
    await this.#provisionalResultHandler.handle({
      execution: input.execution,
      result,
      workspace: input.workspace,
      checkout: input.checkout,
    });
    return "success";
  }
}

export class Phase48_5SandboxPreparationFailureHandler
  implements SandboxPreparationFailureHandler
{
  readonly #failureFinalizer: StartedExecutionFailureFinalizer;

  constructor(failureFinalizer: StartedExecutionFailureFinalizer) {
    this.#failureFinalizer = failureFinalizer;
  }

  async handle(input: {
    readonly execution: PreparedExecution;
    readonly error: unknown;
  }): Promise<void> {
    // Checkout/sandbox preparation failed after Agent Running became durable but
    // before provider invocation could start. No diagnostic is persisted here;
    // Phase 48-5 maps only the canonical durable outcome.
    void input.error;
    await this.#failureFinalizer.finalizeFailure({
      execution: input.execution,
      outcome: "agent_start_failed",
    });
  }
}
