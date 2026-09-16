import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import type {
  PreExecutionRejectionWriter,
  ReFetchedIssue,
  ValidatedHandoff,
} from "../../src/controller/types.js";
import { Phase48_2EligibleCandidateHandler } from "../../src/repository/phase48-2-handler.js";
import {
  RepositoryAccessError,
  type ExactSourceResolvedHandler,
  type RepositorySourceResolver,
} from "../../src/repository/types.js";

const issue: ReFetchedIssue = {
  issueId: 5411,
  projectId: 414,
  lifecycle: "Ready for Agent",
  raw: {},
};
const handoff: ValidatedHandoff = {
  issueId: 5411,
  repository: "mcp-mamono210/redmine",
  approvedRequirementsFingerprint: `sha256:${"a".repeat(64)}`,
  opaque: {},
};
const sourceRevision = "b".repeat(40);

void describe("Phase48_2EligibleCandidateHandler", () => {
  void it("passes repository plus exact source revision to the formal-gate continuation", async () => {
    const nextCalls: unknown[] = [];
    const repository: RepositorySourceResolver = {
      resolveExactSource: mock.fn(() =>
        Promise.resolve({ repository: handoff.repository, sourceRevision }),
      ),
    };
    const rejectionWriter: PreExecutionRejectionWriter = {
      reject: mock.fn(() => Promise.resolve()),
    };
    const next: ExactSourceResolvedHandler = {
      handle: (input) => {
        nextCalls.push(input);
        return Promise.resolve();
      },
    };
    const handler = new Phase48_2EligibleCandidateHandler({
      repository,
      rejectionWriter,
      next,
    });

    await handler.handle({
      issue,
      handoff,
      currentRequirementsFingerprint: handoff.approvedRequirementsFingerprint,
    });

    assert.equal(nextCalls.length, 1);
    assert.deepEqual(nextCalls[0], {
      issue,
      handoff,
      currentRequirementsFingerprint: handoff.approvedRequirementsFingerprint,
      repository: handoff.repository,
      sourceRevision,
    });
  });

  void it("maps early authorization or exact-source failure to eligibility_failed", async () => {
    const rejections: unknown[] = [];
    let nextCalled = false;
    const repository: RepositorySourceResolver = {
      resolveExactSource: () =>
        Promise.reject(
          new RepositoryAccessError(
            "repository_unauthorized",
            "must not expose remote or credentials",
          ),
        ),
    };
    const rejectionWriter: PreExecutionRejectionWriter = {
      reject: (input) => {
        rejections.push(input);
        return Promise.resolve();
      },
    };
    const next: ExactSourceResolvedHandler = {
      handle: () => {
        nextCalled = true;
        return Promise.resolve();
      },
    };
    const handler = new Phase48_2EligibleCandidateHandler({
      repository,
      rejectionWriter,
      next,
    });

    await handler.handle({
      issue,
      handoff,
      currentRequirementsFingerprint: handoff.approvedRequirementsFingerprint,
    });

    assert.deepEqual(rejections, [
      {
        issueId: issue.issueId,
        outcome: "eligibility_failed",
        diagnostic: "repository source preparation failed: repository_unauthorized",
      },
    ]);
    assert.equal(nextCalled, false);
  });
});
