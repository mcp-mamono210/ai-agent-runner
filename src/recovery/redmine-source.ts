import type { RedmineRestClient } from "../redmine/rest-client.js";
import type {
  AgentRunningExecutionCandidate,
  AgentRunningExecutionSource,
} from "./types.js";

const AGENT_RUNNING = "Agent Running";

export class RedmineAgentRunningExecutionSource implements AgentRunningExecutionSource {
  readonly #client: RedmineRestClient;
  readonly #allowedProjectIds: readonly number[];
  readonly #executionLifecycleFieldId: number;

  constructor(input: {
    readonly client: RedmineRestClient;
    readonly allowedProjectIds: readonly number[];
    readonly executionLifecycleFieldId: number;
  }) {
    if (input.allowedProjectIds.length === 0) {
      throw new Error("allowedProjectIds must not be empty");
    }
    if (!Number.isSafeInteger(input.executionLifecycleFieldId) || input.executionLifecycleFieldId <= 0) {
      throw new Error("executionLifecycleFieldId must be a positive safe integer");
    }
    this.#client = input.client;
    this.#allowedProjectIds = Object.freeze([...input.allowedProjectIds]);
    this.#executionLifecycleFieldId = input.executionLifecycleFieldId;
  }

  async listAgentRunningExecutions(): Promise<readonly AgentRunningExecutionCandidate[]> {
    const output: AgentRunningExecutionCandidate[] = [];
    for (const projectId of this.#allowedProjectIds) {
      const issues = await this.#client.listIssuesByCustomField({
        projectId,
        customFieldId: this.#executionLifecycleFieldId,
        value: AGENT_RUNNING,
        limit: 100,
      });
      for (const issue of issues) {
        if (issue.projectId !== projectId) {
          throw new Error("Agent Running query returned an issue outside the requested project");
        }
        output.push({ issueId: issue.id, projectId: issue.projectId });
      }
    }
    return Object.freeze(output);
  }
}
