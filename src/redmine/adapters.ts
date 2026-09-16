import type {
  CandidateSource,
  IssueReader,
  ReadyForAgentCandidate,
  ReFetchedIssue,
} from "../controller/types.js";
import {
  READY_FOR_AGENT_LIFECYCLE,
} from "../controller/types.js";
import {
  findUniqueCustomField,
  scalarCustomFieldValue,
} from "./domain.js";
import type { RedmineRestClient } from "./rest-client.js";

export interface RedmineCandidateSourceOptions {
  readonly lifecycleFieldId: number;
}

export class RedmineCandidateSource implements CandidateSource {
  readonly #client: RedmineRestClient;
  readonly #lifecycleFieldId: number;

  constructor(
    client: RedmineRestClient,
    options: RedmineCandidateSourceOptions,
  ) {
    if (!Number.isSafeInteger(options.lifecycleFieldId) || options.lifecycleFieldId <= 0) {
      throw new Error("lifecycleFieldId must be a positive safe integer");
    }
    this.#client = client;
    this.#lifecycleFieldId = options.lifecycleFieldId;
  }

  async listReadyForAgentCandidates(input: {
    readonly allowedProjectIds: readonly number[];
    readonly lifecycle: typeof READY_FOR_AGENT_LIFECYCLE;
    readonly limit: 1;
  }): Promise<readonly ReadyForAgentCandidate[]> {
    if (input.lifecycle !== READY_FOR_AGENT_LIFECYCLE) {
      throw new Error("candidate source only supports Ready for Agent");
    }

    for (const projectId of input.allowedProjectIds) {
      const matches = await this.#client.listReadyForAgentCandidates({
        projectId,
        lifecycleFieldId: this.#lifecycleFieldId,
        lifecycleValue: input.lifecycle,
        limit: input.limit,
      });

      const first = matches[0];
      if (first !== undefined) {
        return [{ issueId: first.id, projectId: first.projectId }];
      }
    }

    return [];
  }
}

export class RedmineIssueReader implements IssueReader {
  readonly #client: RedmineRestClient;

  constructor(client: RedmineRestClient) {
    this.#client = client;
  }

  async getIssue(issueId: number): Promise<ReFetchedIssue> {
    const issue = await this.#client.getIssue(issueId);
    const lifecycle = scalarCustomFieldValue(
      findUniqueCustomField(issue, "Agent Brief Lifecycle"),
    );

    return {
      issueId: issue.id,
      projectId: issue.project.id,
      lifecycle,
      raw: issue,
    };
  }
}
