import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RedmineCandidateSource, RedmineIssueReader } from "../../src/redmine/adapters.js";
import { RedmineRestClient } from "../../src/redmine/rest-client.js";
import type { CandidateDiagnosticSink } from "../../src/controller/types.js";

const EXECUTION_FIELDS = [
  [11, "Agent Execution Lifecycle"],
  [15, "Agent Execution ID"],
  [16, "Agent Exec Brief Revision"],
  [17, "Agent Exec Persisted Revision"],
  [18, "Agent Exec Req Fingerprint"],
  [19, "Agent Execution Repository"],
  [20, "Agent Exec Source Revision"],
  [21, "Agent Execution Started At"],
  [22, "Agent Execution Finished At"],
  [23, "Agent Execution Outcome"],
  [24, "Agent Artifact Reference"],
  [12, "Agent Rejection At"],
  [13, "Agent Rejection Outcome"],
  [14, "Agent Rejection Diagnostic"],
] as const;

interface ExecutionCustomFieldFixture {
  readonly id: number;
  readonly name: string;
  value: string;
}

function pristineExecutionCustomFields(): ExecutionCustomFieldFixture[] {
  return EXECUTION_FIELDS.map(([id, name]) => ({ id, name, value: "" }));
}

function fetchImpl(input: RequestInfo | URL): Promise<Response> {
  const url = requestUrl(input);
  if (url.pathname.endsWith("/issues.json")) {
    assert.equal(url.searchParams.get("project_id"), "414");
    assert.equal(url.searchParams.get("subproject_id"), "!*");
    assert.equal(url.searchParams.get("cf_9"), "Ready for Agent");
    assert.equal(url.searchParams.get("cf_11"), "!*");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.get("sort"), "id:asc");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          issues: [
            {
              id: 9002,
              project: { id: 414, name: "Redmine" },
              custom_fields: [
                { id: 9, name: "Agent Brief Lifecycle", value: "Ready for Agent" },
                { id: 11, name: "Agent Execution Lifecycle", value: "" },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
  }

  if (url.pathname.endsWith("/issues/9002.json")) {
    assert.equal(url.searchParams.get("include"), "journals,relations,children");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          issue: {
            id: 9002,
            project: { id: 414, name: "Redmine" },
            tracker: { id: 2, name: "Feature" },
            subject: "Candidate",
            description: "Candidate description",
            updated_on: "2026-09-27T00:00:00Z",
            custom_fields: [
              { id: 9, name: "Agent Brief Lifecycle", value: "Ready for Agent" },
              ...pristineExecutionCustomFields(),
            ],
            journals: [],
            relations: [],
            children: [],
          },
        }),
        { status: 200 },
      ),
    );
  }

  return Promise.resolve(new Response("not found", { status: 404 }));
}

function client(overrideFetch: typeof fetch = fetchImpl): RedmineRestClient {
  return new RedmineRestClient({
    baseUrl: "https://redmine.example.test",
    readApiKey: "read-key",
    writeApiKey: "write-key",
    fetchImpl: overrideFetch,
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === "string") {
    return new URL(input);
  }
  return new URL(input.url);
}

void describe("Redmine Phase 53 candidate adapters", () => {
  void it("uses exact project, no-subproject, Ready-for-Agent, and empty execution lifecycle predicates", async () => {
    const source = new RedmineCandidateSource(client(), {
      lifecycleFieldId: 9,
      executionLifecycleFieldId: 11,
    });
    const candidates = await source.listReadyForAgentCandidates({
      allowedProjectIds: [414],
      lifecycle: "Ready for Agent",
      limit: 100,
    });
    assert.deepEqual(candidates, [{ issueId: 9002, projectId: 414 }]);
  });

  void it("fails closed with query_predicate_mismatch when Redmine ignores the execution custom-field filter", async () => {
    const diagnostics: unknown[] = [];
    const diagnosticSink: CandidateDiagnosticSink = {
      record: (input) => {
        diagnostics.push(input);
        return Promise.resolve();
      },
    };
    const ignoredFilterFetch = (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      assert.equal(url.searchParams.get("cf_11"), "!*");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            issues: [
              {
                id: 9001,
                project: { id: 414, name: "Redmine" },
                custom_fields: [
                  { id: 9, value: "Ready for Agent" },
                  { id: 11, value: "Needs Human" },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      );
    };
    const source = new RedmineCandidateSource(client(ignoredFilterFetch), {
      lifecycleFieldId: 9,
      executionLifecycleFieldId: 11,
      diagnosticSink,
    });

    await assert.rejects(
      source.listReadyForAgentCandidates({
        allowedProjectIds: [414],
        lifecycle: "Ready for Agent",
        limit: 100,
      }),
      /query predicate mismatch/u,
    );
    assert.deepEqual(diagnostics, [
      {
        kind: "query_predicate_mismatch",
        issueId: 9001,
        reason:
          "candidate list item did not satisfy the requested project and lifecycle predicate",
      },
    ]);
  });

  void it("fails closed when a child-project Issue leaks through the no-subproject query", async () => {
    const diagnostics: unknown[] = [];
    const diagnosticSink: CandidateDiagnosticSink = {
      record: (input) => {
        diagnostics.push(input);
        return Promise.resolve();
      },
    };
    const childProjectFetch = (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      assert.equal(url.searchParams.get("project_id"), "414");
      assert.equal(url.searchParams.get("subproject_id"), "!*");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            issues: [
              {
                id: 9001,
                project: { id: 415, name: "Redmine child" },
                custom_fields: [
                  { id: 9, value: "Ready for Agent" },
                  { id: 11, value: "" },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      );
    };
    const source = new RedmineCandidateSource(client(childProjectFetch), {
      lifecycleFieldId: 9,
      executionLifecycleFieldId: 11,
      diagnosticSink,
    });

    await assert.rejects(
      source.listReadyForAgentCandidates({
        allowedProjectIds: [414],
        lifecycle: "Ready for Agent",
        limit: 100,
      }),
      /query predicate mismatch/u,
    );
    assert.deepEqual(diagnostics, [
      {
        kind: "query_predicate_mismatch",
        issueId: 9001,
        reason:
          "candidate list item did not satisfy the requested project and lifecycle predicate",
      },
    ]);
  });

  void it("re-fetches the Issue and resolves the complete execution/rejection pristine guard", async () => {
    const reader = new RedmineIssueReader(client());
    const issue = await reader.getIssue(9002);
    assert.equal(issue.issueId, 9002);
    assert.equal(issue.projectId, 414);
    assert.equal(issue.lifecycle, "Ready for Agent");
    assert.deepEqual(issue.postLockState, {
      executionLifecycle: "",
      executionRecordPristine: true,
    });
  });

  void it("marks an otherwise eligible Issue non-pristine when any durable rejection field is populated", async () => {
    const nonPristineFetch = (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.pathname.endsWith("/issues/9002.json")) {
        return fetchImpl(input);
      }
      const executionFields = pristineExecutionCustomFields().map((field) => ({ ...field }));
      const rejection = executionFields.find(
        (field) => field.name === "Agent Rejection Outcome",
      );
      if (rejection === undefined) {
        throw new Error("Agent Rejection Outcome fixture is missing");
      }
      rejection.value = "eligibility_failed";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            issue: {
              id: 9002,
              project: { id: 414, name: "Redmine" },
              tracker: { id: 2, name: "Feature" },
              subject: "Candidate",
              description: "Candidate description",
              updated_on: "2026-09-27T00:00:00Z",
              custom_fields: [
                { id: 9, name: "Agent Brief Lifecycle", value: "Ready for Agent" },
                ...executionFields,
              ],
              journals: [],
              relations: [],
              children: [],
            },
          }),
          { status: 200 },
        ),
      );
    };

    const issue = await new RedmineIssueReader(client(nonPristineFetch)).getIssue(9002);
    assert.equal(issue.postLockState?.executionRecordPristine, false);
  });
});
