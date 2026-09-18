import type { AgentRunningConfirmedHandler, PreparedExecution } from "../execution/types.js";
import type { RepositoryCheckout } from "../repository/types.js";
import type {
  SandboxDisposalReason,
  SandboxPreparationFailureHandler,
  SandboxPreparedHandler,
  SandboxRuntime,
  TaskWorkspace,
} from "./types.js";
import type { TaskWorkspaceManager } from "./workspace.js";

export class Phase48_4AgentRunningConfirmedHandler
  implements AgentRunningConfirmedHandler
{
  readonly #workspaceManager: TaskWorkspaceManager;
  readonly #repository: RepositoryCheckout;
  readonly #sandboxRuntime: SandboxRuntime;
  readonly #next: SandboxPreparedHandler;
  readonly #preAgentFailureHandler: SandboxPreparationFailureHandler;

  constructor(input: {
    readonly workspaceManager: TaskWorkspaceManager;
    readonly repository: RepositoryCheckout;
    readonly sandboxRuntime: SandboxRuntime;
    readonly next: SandboxPreparedHandler;
    readonly preAgentFailureHandler: SandboxPreparationFailureHandler;
  }) {
    this.#workspaceManager = input.workspaceManager;
    this.#repository = input.repository;
    this.#sandboxRuntime = input.sandboxRuntime;
    this.#next = input.next;
    this.#preAgentFailureHandler = input.preAgentFailureHandler;
  }

  async handle(execution: PreparedExecution): Promise<void> {
    let workspace: TaskWorkspace | undefined;
    let sandboxCreated = false;
    let sandbox: Awaited<ReturnType<SandboxRuntime["create"]>> | undefined;
    let disposalReason: SandboxDisposalReason = "failure";

    try {
      workspace = await this.#workspaceManager.create(execution.input.executionId);
      const checkout = await this.#repository.checkout({
        repository: execution.input.repository,
        sourceRevision: execution.input.sourceRevision,
        targetDir: workspace.path,
      });
      if (
        checkout.repository !== execution.input.repository ||
        checkout.sourceRevision !== execution.input.sourceRevision ||
        checkout.targetDir !== workspace.path ||
        checkout.headRevision !== execution.input.sourceRevision
      ) {
        throw new Error("Phase 48-2 checkout result does not match immutable execution input");
      }
      await workspace.assertWithinDiskLimit();
      sandbox = await this.#sandboxRuntime.create({ execution, workspace });
      sandboxCreated = true;
      disposalReason = await this.#next.handle({
        execution,
        workspace,
        checkout,
        sandbox,
      });
    } catch (error) {
      if (!sandboxCreated) {
        await this.#preAgentFailureHandler.handle({ execution, error });
      }
      throw error;
    } finally {
      if (sandbox !== undefined) {
        await sandbox.dispose(disposalReason);
      } else if (workspace !== undefined) {
        await workspace.dispose();
      }
    }
  }
}
