import type {
  CandidateDiagnosticSink,
  CandidateSource,
  IssueReader,
  ReadyForAgentCandidate,
  ReFetchedIssue,
} from "../controller/types.js";
import {
  READY_FOR_AGENT_LIFECYCLE,
} from "../controller/types.js";
import {
  NoopCandidateDiagnosticSink,
  recordCandidateDiagnostic,
} from "../controller/candidate-diagnostic.js";
import {
  findUniqueCustomField,
  scalarCustomFieldValue,
} from "./domain.js";
import type { RedmineIssueRecord } from "./domain.js";
import type { RedmineRestClient } from "./rest-client.js";

const EXECUTION_RECORD_FIELD_NAMES = Object.freeze([
  "Agent Execution Lifecycle",
  "Agent Execution ID",
  "Agent Exec Brief Revision",
  "Agent Exec Persisted Revision",
  "Agent Exec Req Fingerprint",
  "Agent Execution Repository",
  "Agent Exec Source Revision",
  "Agent Execution Started At",
  "Agent Execution Finished At",
  "Agent Execution Outcome",
  "Agent Artifact Reference",
  "Agent Rejection At",
  "Agent Rejection Outcome",
  "Agent Rejection Diagnostic",
] as const);

export interface RedmineCandidateSourceOptions {
  readonly lifecycleFieldId: number;
  readonly executionLifecycleFieldId: number;
  readonly diagnosticSink?: CandidateDiagnosticSink;
}

export class RedmineCandidateSource implements CandidateSource {
  readonly #client: RedmineRestClient;
  readonly #lifecycleFieldId: number;
  readonly #executionLifecycleFieldId: number;
  readonly #diagnosticSink: CandidateDiagnosticSink;

  constructor(
    client: RedmineRestClient,
    options: RedmineCandidateSourceOptions,
  ) {
    if (!Number.isSafeInteger(options.lifecycleFieldId) || options.lifecycleFieldId <= 0) {
      throw new Error("lifecycleFieldId must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(options.executionLifecycleFieldId) ||
      options.executionLifecycleFieldId <= 0
    ) {
      throw new Error("executionLifecycleFieldId must be a positive safe integer");
    }
    if (options.lifecycleFieldId === options.executionLifecycleFieldId) {
      throw new Error("brief and execution lifecycle field IDs must differ");
    }
    this.#client = client;
    this.#lifecycleFieldId = options.lifecycleFieldId;
    this.#executionLifecycleFieldId = options.executionLifecycleFieldId;
    this.#diagnosticSink = options.diagnosticSink ?? new NoopCandidateDiagnosticSink();
  }

  async listReadyForAgentCandidates(input: {
    readonly allowedProjectIds: readonly number[];
    readonly lifecycle: typeof READY_FOR_AGENT_LIFECYCLE;
    readonly limit: number;
  }): Promise<readonly ReadyForAgentCandidate[]> {
    if (input.lifecycle !== READY_FOR_AGENT_LIFECYCLE) {
      throw new Error("candidate source only supports Ready for Agent");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 100) {
      throw new Error("candidate source limit must be between 1 and 100");
    }

    const candidates: ReadyForAgentCandidate[] = [];

    for (const projectId of input.allowedProjectIds) {
      if (candidates.length >= input.limit) {
        break;
      }
      const remaining = input.limit - candidates.length;
      const matches = await this.#client.listReadyForAgentCandidates({
        projectId,
        briefLifecycleFieldId: this.#lifecycleFieldId,
        executionLifecycleFieldId: this.#executionLifecycleFieldId,
        lifecycleValue: input.lifecycle,
        limit: remaining,
      });

      for (const match of matches) {
        if (
          match.projectId !== projectId ||
          match.briefLifecycle !== input.lifecycle ||
          match.executionLifecycle !== ""
        ) {
          await recordCandidateDiagnostic(this.#diagnosticSink, {
            kind: "query_predicate_mismatch",
            issueId: match.id,
            reason:
              "candidate list item did not satisfy the requested project and lifecycle predicate",
          });
          throw new Error("candidate polling stopped: query predicate mismatch");
        }

        candidates.push({ issueId: match.id, projectId: match.projectId });
      }
    }

    return candidates;
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
    const executionLifecycle = scalarCustomFieldValue(
      findUniqueCustomField(issue, "Agent Execution Lifecycle"),
    );

    return {
      issueId: issue.id,
      projectId: issue.project.id,
      lifecycle,
      postLockState: {
        executionLifecycle,
        executionRecordPristine: isExecutionRecordPristine(issue),
      },
      raw: issue,
    };
  }
}

function isExecutionRecordPristine(issue: RedmineIssueRecord): boolean {
  return EXECUTION_RECORD_FIELD_NAMES.every((fieldName) =>
    scalarCustomFieldValue(findUniqueCustomField(issue, fieldName)) === ""
  );
}
