import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentController } from "../../src/controller/controller.js";
import { Phase48_3ExactSourceResolvedHandler } from "../../src/execution/preparation.js";
import type { LocalIssueLock } from "../../src/controller/local-lock.js";
import type { ReFetchedIssue, ValidatedHandoff } from "../../src/controller/types.js";
import { RedmineAgentRunningWriter } from "../../src/redmine/execution-writer.js";
import { RedminePreExecutionRejectionWriter } from "../../src/redmine/rejection-writer.js";
import { RedmineRestClient } from "../../src/redmine/rest-client.js";

const ISSUE_ID = 9002;
const PROJECT_ID = 414;
const REPOSITORY = "mcp-mamono210/redmine";
const SOURCE_REVISION = "b".repeat(40);
const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";

interface MutableField {
  id: number;
  name: string;
  value: string;
}

const FIELD_NAMES = [
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
] as const;

function fields(): MutableField[] {
  return FIELD_NAMES.map((name, index) => ({ id: 11 + index, name, value: "" }));
}

function issuePayload(currentFields: readonly MutableField[]): unknown {
  return {
    issue: {
      id: ISSUE_ID,
      project: { id: PROJECT_ID, name: "Redmine" },
      tracker: { id: 2, name: "Feature" },
      subject: "Phase 53 combined regression",
      description: "fixture",
      updated_on: "2026-09-27T00:00:00Z",
      custom_fields: currentFields,
      journals: [],
      relations: [],
      children: [],
    },
  };
}

function readyIssue(): ReFetchedIssue {
  return {
    issueId: ISSUE_ID,
    projectId: PROJECT_ID,
    lifecycle: "Ready for Agent",
    postLockState: {
      executionLifecycle: "",
      executionRecordPristine: true,
    },
    raw: { id: ISSUE_ID },
  };
}

function handoff(): ValidatedHandoff {
  return {
    issueId: ISSUE_ID,
    repository: REPOSITORY,
    approvedRequirementsFingerprint: FINGERPRINT,
    approval: {
      approverIdentity: "redmine-user:10",
      approvedAt: "2026-09-27T00:00:00Z",
      briefRevision: 3,
      persistedRevision: "persisted-revision",
    },
    opaque: {},
  };
}

function recordingLock(order: string[]): LocalIssueLock {
  let held = false;
  return {
    tryAcquire: () => {
      order.push("local-lock");
      if (held) {
        return false;
      }
      held = true;
      return true;
    },
    release: () => {
      held = false;
      order.push("local-unlock");
    },
    isHeld: () => held,
  };
}

function controllerWithWriter(input: {
  readonly writer: RedmineAgentRunningWriter;
  readonly order: string[];
  readonly agentInvocation: () => Promise<void>;
}): AgentController {
  const exactSourceHandler = new Phase48_3ExactSourceResolvedHandler({
    formalGate: {
      authorize: () => {
        input.order.push("formal-gate");
        return Promise.resolve();
      },
    },
    rejectionWriter: {
      reject: () => Promise.reject(new Error("unexpected execution-preparation rejection")),
    },
    executionIdAllocator: { allocate: () => EXECUTION_ID },
    agentRunningWriter: input.writer,
    next: {
      handle: async () => {
        input.order.push("agent-invocation");
        await input.agentInvocation();
      },
    },
    clock: () => new Date("2026-09-27T00:01:00Z"),
  });

  return new AgentController(
    { allowedProjectIds: [PROJECT_ID], pollIntervalMs: 30_000 },
    {
      candidateSource: {
        listReadyForAgentCandidates: () => {
          input.order.push("candidate-query");
          return Promise.resolve([{ issueId: ISSUE_ID, projectId: PROJECT_ID }]);
        },
      },
      localLock: recordingLock(input.order),
      issueReader: {
        getIssue: () => {
          input.order.push("post-lock-refetch");
          return Promise.resolve(readyIssue());
        },
      },
      handoffValidator: {
        validate: () => {
          input.order.push("handoff-validation");
          return Promise.resolve({ ok: true as const, handoff: handoff() });
        },
      },
      requirementsRevalidator: {
        revalidate: () => {
          input.order.push("requirements-revalidation");
          return Promise.resolve({ kind: "current" as const, currentFingerprint: FINGERPRINT });
        },
      },
      rejectionWriter: {
        reject: () => Promise.reject(new Error("unexpected controller rejection")),
      },
      startupReconciler: { reconcile: () => Promise.resolve() },
      eligibleCandidateHandler: {
        handle: ({ issue, handoff: validatedHandoff, currentRequirementsFingerprint }) =>
          exactSourceHandler.handle({
            issue,
            handoff: validatedHandoff,
            currentRequirementsFingerprint,
            repository: REPOSITORY,
            sourceRevision: SOURCE_REVISION,
          }),
      },
      sleeper: { sleep: () => Promise.resolve() },
    },
  );
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

void describe("Phase 53-1 / 53-2 writer guard integration", () => {
  void it("runs candidate through post-lock eligibility, writer pre-read, durable write, then one Agent invocation", async () => {
    const order: string[] = [];
    const currentFields = fields();
    let agentInvocations = 0;
    let writerGets = 0;
    const client = new RedmineRestClient({
      baseUrl: "https://redmine.example.test",
      readApiKey: "read-key",
      writeApiKey: "write-key",
      fetchImpl: (request, init) => {
        const url = requestUrl(request);
        if (!url.pathname.endsWith(`/issues/${ISSUE_ID}.json`)) {
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        if ((init?.method ?? "GET") === "PUT") {
          order.push("agent-running-write");
          const body = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(body) as {
            issue: { custom_fields: Array<{ id: number; value: string }> };
          };
          for (const update of parsed.issue.custom_fields) {
            const field = currentFields.find((candidate) => candidate.id === update.id);
            if (field === undefined) {
              throw new Error("unexpected durable field write");
            }
            field.value = update.value;
          }
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        writerGets += 1;
        order.push(writerGets === 1 ? "writer-pre-read" : "writer-read-back");
        return Promise.resolve(new Response(JSON.stringify(issuePayload(currentFields)), { status: 200 }));
      },
    });
    const controller = controllerWithWriter({
      writer: new RedmineAgentRunningWriter({ client, allowedProjectIds: [PROJECT_ID] }),
      order,
      agentInvocation: () => {
        agentInvocations += 1;
        return Promise.resolve();
      },
    });

    await controller.runOnce();

    assert.equal(agentInvocations, 1);
    assert.deepEqual(order, [
      "candidate-query",
      "local-lock",
      "post-lock-refetch",
      "handoff-validation",
      "requirements-revalidation",
      "formal-gate",
      "writer-pre-read",
      "agent-running-write",
      "writer-read-back",
      "agent-invocation",
      "local-unlock",
    ]);
  });

  void it("refuses a pre-write durable-state race and performs neither Redmine mutation nor Agent invocation", async () => {
    const order: string[] = [];
    const currentFields = fields();
    const racedField = currentFields.find((field) => field.name === "Agent Rejection Outcome");
    if (racedField === undefined) {
      throw new Error("race fixture field is missing");
    }
    racedField.value = "eligibility_failed";
    let putCount = 0;
    let agentInvocations = 0;
    const client = new RedmineRestClient({
      baseUrl: "https://redmine.example.test",
      readApiKey: "read-key",
      writeApiKey: "write-key",
      fetchImpl: (request, init) => {
        const url = requestUrl(request);
        if (!url.pathname.endsWith(`/issues/${ISSUE_ID}.json`)) {
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        if ((init?.method ?? "GET") === "PUT") {
          putCount += 1;
          order.push("unexpected-write");
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        order.push("writer-pre-read");
        return Promise.resolve(new Response(JSON.stringify(issuePayload(currentFields)), { status: 200 }));
      },
    });
    const controller = controllerWithWriter({
      writer: new RedmineAgentRunningWriter({ client, allowedProjectIds: [PROJECT_ID] }),
      order,
      agentInvocation: () => {
        agentInvocations += 1;
        return Promise.resolve();
      },
    });

    await assert.rejects(
      controller.runOnce(),
      /durable execution\/rejection state is not pristine/u,
    );

    assert.equal(putCount, 0);
    assert.equal(agentInvocations, 0);
    assert.equal(order.includes("unexpected-write"), false);
    assert.equal(order.includes("agent-invocation"), false);
    assert.equal(order.at(-1), "local-unlock");
  });

  void it("refuses a pre-execution rejection race and never reaches the Agent path", async () => {
    const order: string[] = [];
    const currentFields = fields();
    const racedField = currentFields.find((field) => field.name === "Agent Execution ID");
    if (racedField === undefined) {
      throw new Error("rejection race fixture field is missing");
    }
    racedField.value = "existing-execution-id";
    let putCount = 0;
    let agentInvocations = 0;
    const client = new RedmineRestClient({
      baseUrl: "https://redmine.example.test",
      readApiKey: "read-key",
      writeApiKey: "write-key",
      fetchImpl: (request, init) => {
        const url = requestUrl(request);
        if (!url.pathname.endsWith(`/issues/${ISSUE_ID}.json`)) {
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        if ((init?.method ?? "GET") === "PUT") {
          putCount += 1;
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        order.push("rejection-pre-read");
        return Promise.resolve(new Response(JSON.stringify(issuePayload(currentFields)), { status: 200 }));
      },
    });
    const rejectionWriter = new RedminePreExecutionRejectionWriter({
      client,
      allowedProjectIds: [PROJECT_ID],
    });
    const controller = new AgentController(
      { allowedProjectIds: [PROJECT_ID], pollIntervalMs: 30_000 },
      {
        candidateSource: {
          listReadyForAgentCandidates: () => Promise.resolve([
            { issueId: ISSUE_ID, projectId: PROJECT_ID },
          ]),
        },
        localLock: recordingLock(order),
        issueReader: { getIssue: () => Promise.resolve(readyIssue()) },
        handoffValidator: {
          validate: () => Promise.resolve({ ok: true as const, handoff: handoff() }),
        },
        requirementsRevalidator: {
          revalidate: () => Promise.resolve({
            kind: "stale" as const,
            currentFingerprint: `sha256:${"c".repeat(64)}`,
            approvedFingerprint: FINGERPRINT,
          }),
        },
        rejectionWriter,
        startupReconciler: { reconcile: () => Promise.resolve() },
        eligibleCandidateHandler: {
          handle: () => {
            agentInvocations += 1;
            return Promise.resolve();
          },
        },
        sleeper: { sleep: () => Promise.resolve() },
      },
    );

    await assert.rejects(
      controller.runOnce(),
      /durable execution\/rejection state is not pristine/u,
    );

    assert.equal(putCount, 0);
    assert.equal(agentInvocations, 0);
    assert.equal(order.includes("rejection-pre-read"), true);
    assert.equal(order.at(-1), "local-unlock");
  });

});
