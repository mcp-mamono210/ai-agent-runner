import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  PreExecutionRejectionWriter,
  ReFetchedIssue,
  ValidatedHandoff,
} from "../../src/controller/types.js";
import { Phase47FormalAuthorizationGate } from "../../src/execution/formal-gate.js";
import {
  Phase48_3ExactSourceResolvedHandler,
  UuidV4ExecutionIdAllocator,
} from "../../src/execution/preparation.js";
import type {
  AgentRunningConfirmedHandler,
  AgentRunningDurableWriter,
  ExecutionIdAllocator,
  FormalAuthorizationGate,
  PreparedExecution,
} from "../../src/execution/types.js";
import {
  loadRepositoryAuthorizationConfiguration,
  RepositoryAccessPolicy,
} from "../../src/repository/policy.js";
import type { ExactSourceResolvedInput } from "../../src/repository/types.js";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const SOURCE_REVISION = "b".repeat(40);
const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";

const issue: ReFetchedIssue = {
  issueId: 5412,
  projectId: 414,
  lifecycle: "Ready for Agent",
  raw: {},
};

const handoff: ValidatedHandoff = {
  issueId: 5412,
  repository: "mcp-mamono210/redmine",
  approvedRequirementsFingerprint: FINGERPRINT,
  approval: {
    approverIdentity: "redmine-user:3",
    approvedAt: "2026-09-17T00:00:00Z",
    briefRevision: 7,
    persistedRevision: "abc123",
  },
  opaque: {},
};

function resolvedInput(): ExactSourceResolvedInput {
  return {
    issue,
    handoff,
    currentRequirementsFingerprint: FINGERPRINT,
    repository: handoff.repository,
    sourceRevision: SOURCE_REVISION,
  };
}

void describe("Phase 48-3 execution preparation", () => {
  void it("runs the formal gate before allocating execution_id", async () => {
    const events: string[] = [];
    const formalGate: FormalAuthorizationGate = {
      authorize: () => {
        events.push("gate");
        return Promise.resolve();
      },
    };
    const executionIdAllocator: ExecutionIdAllocator = {
      allocate: () => {
        events.push("allocate");
        return EXECUTION_ID;
      },
    };
    const rejectionWriter: PreExecutionRejectionWriter = {
      reject: () => Promise.reject(new Error("unexpected rejection")),
    };
    let persisted: PreparedExecution | undefined;
    const agentRunningWriter: AgentRunningDurableWriter = {
      persistAndConfirm: (execution) => {
        events.push("persist");
        persisted = execution;
        return Promise.resolve();
      },
    };
    const next: AgentRunningConfirmedHandler = {
      handle: () => {
        events.push("next");
        return Promise.resolve();
      },
    };
    const handler = new Phase48_3ExactSourceResolvedHandler({
      formalGate,
      rejectionWriter,
      executionIdAllocator,
      agentRunningWriter,
      next,
      clock: () => new Date("2026-09-17T01:02:03Z"),
    });

    await handler.handle(resolvedInput());

    assert.deepEqual(events, ["gate", "allocate", "persist", "next"]);
    assert.ok(persisted !== undefined);
    assert.equal(persisted.input.executionId, EXECUTION_ID);
    assert.equal(persisted.input.issueId, 5412);
    assert.equal(persisted.input.repository, handoff.repository);
    assert.equal(persisted.input.sourceRevision, SOURCE_REVISION);
    assert.equal(persisted.input.briefRevision, 7);
    assert.equal(persisted.input.persistedRevision, "abc123");
    assert.equal(persisted.input.requirementsFingerprint, FINGERPRINT);
    assert.deepEqual(persisted.input.approvedBriefReference, {
      repository: handoff.repository,
      issueId: 5412,
      briefRevision: 7,
      persistedRevision: "abc123",
    });
    assert.equal(persisted.record.startedAt, "2026-09-17T01:02:03.000Z");
    assert.deepEqual(persisted.record.finishedAt, { kind: "pending" });
    assert.equal(Object.isFrozen(persisted), true);
    assert.equal(Object.isFrozen(persisted.input), true);
    assert.equal(Object.isFrozen(persisted.input.approvedBriefReference), true);
    assert.equal(Object.isFrozen(persisted.record), true);
  });

  void it("rejects handoff identity drift before formal authorization or execution_id allocation", async () => {
    let gateCalled = false;
    let allocated = false;
    const rejections: unknown[] = [];
    const handler = new Phase48_3ExactSourceResolvedHandler({
      formalGate: {
        authorize: () => {
          gateCalled = true;
          return Promise.resolve();
        },
      },
      rejectionWriter: {
        reject: (input) => {
          rejections.push(input);
          return Promise.resolve();
        },
      },
      executionIdAllocator: {
        allocate: () => {
          allocated = true;
          return EXECUTION_ID;
        },
      },
      agentRunningWriter: { persistAndConfirm: () => Promise.resolve() },
      next: { handle: () => Promise.resolve() },
    });
    const input = resolvedInput();

    await handler.handle({
      ...input,
      repository: "mcp-mamono210/other",
    });

    assert.equal(gateCalled, false);
    assert.equal(allocated, false);
    assert.deepEqual(rejections, [
      {
        issueId: 5412,
        outcome: "eligibility_failed",
        diagnostic:
          "execution preparation eligibility failed: validated handoff repository identity changed before formal authorization",
      },
    ]);
  });

  void it("keeps formal-gate failure execution-ID-less and writes eligibility_failed", async () => {
    let allocated = false;
    let persisted = false;
    let nextCalled = false;
    const rejections: unknown[] = [];
    const handler = new Phase48_3ExactSourceResolvedHandler({
      formalGate: {
        authorize: () => Promise.reject(new Error("not authorized")),
      },
      rejectionWriter: {
        reject: (input) => {
          rejections.push(input);
          return Promise.resolve();
        },
      },
      executionIdAllocator: {
        allocate: () => {
          allocated = true;
          return EXECUTION_ID;
        },
      },
      agentRunningWriter: {
        persistAndConfirm: () => {
          persisted = true;
          return Promise.resolve();
        },
      },
      next: {
        handle: () => {
          nextCalled = true;
          return Promise.resolve();
        },
      },
    });

    await handler.handle(resolvedInput());

    assert.equal(allocated, false);
    assert.equal(persisted, false);
    assert.equal(nextCalled, false);
    assert.deepEqual(rejections, [
      {
        issueId: 5412,
        outcome: "eligibility_failed",
        diagnostic: "formal Phase 47 authorization failed: not authorized",
      },
    ]);
  });

  void it("does not continue when Agent Running durable confirmation fails", async () => {
    let nextCalled = false;
    const handler = new Phase48_3ExactSourceResolvedHandler({
      formalGate: { authorize: () => Promise.resolve() },
      rejectionWriter: { reject: () => Promise.resolve() },
      executionIdAllocator: { allocate: () => EXECUTION_ID },
      agentRunningWriter: {
        persistAndConfirm: () => Promise.reject(new Error("read-back mismatch")),
      },
      next: {
        handle: () => {
          nextCalled = true;
          return Promise.resolve();
        },
      },
    });

    await assert.rejects(handler.handle(resolvedInput()), /read-back mismatch/u);
    assert.equal(nextCalled, false);
  });

  void it("re-establishes repository authorization using the unchanged identity and exact source", async () => {
    const configuration = loadRepositoryAuthorizationConfiguration(
      " mcp-mamono210/redmine |https://github.com/mcp-mamono210/redmine.git|refs/heads/main|USER_ENV|TOKEN_ENV",
    );
    const gate = new Phase47FormalAuthorizationGate(
      new RepositoryAccessPolicy(configuration),
    );

    await gate.authorize({
      repository: "mcp-mamono210/redmine",
      sourceRevision: SOURCE_REVISION,
    });
    await assert.rejects(
      gate.authorize({
        repository: "MCP-MAMONO210/redmine",
        sourceRevision: SOURCE_REVISION,
      }),
      /not authorized/u,
    );
    await assert.rejects(
      gate.authorize({
        repository: "mcp-mamono210/redmine",
        sourceRevision: "main",
      }),
      /exact lowercase Git object ID/u,
    );
  });

  void it("allocates canonical lowercase UUIDv4 values", () => {
    const allocator = new UuidV4ExecutionIdAllocator();
    const value = allocator.allocate();
    assert.match(
      value,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    assert.equal(value.length, 36);
  });
});
