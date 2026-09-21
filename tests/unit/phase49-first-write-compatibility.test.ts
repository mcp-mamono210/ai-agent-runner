import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CustomFieldWrite, RedmineIssueRecord } from "../../src/redmine/domain.js";
import {
  RedminePhase49FirstWriteCompatibilityVerifier,
  type Phase49CompatibilityRedmineClient,
} from "../../src/redmine/phase49-first-write-verifier.js";

void describe("Phase 49 first-write compatibility verifier", () => {
  void it("writes the three first-use values and requires exact read-back", async () => {
    const client = new FakeCompatibilityClient(issueFixture());
    const verifier = new RedminePhase49FirstWriteCompatibilityVerifier({
      client,
      allowedProjectIds: [414],
    });

    await verifier.verify({
      fixtureIssueId: 9001,
      representativeArtifactReference: "s3://phase49-artifacts-example/phase49/artifacts/123e4567-e89b-42d3-a456-426614174000.json",
    });

    assert.equal(client.writeCount, 1);
    const values = new Map(client.issue.customFields.map((field) => [field.name, field.value]));
    assert.equal(values.get("Agent Execution Lifecycle"), "Ready for Independent Verification");
    assert.equal(values.get("Agent Execution Outcome"), "artifact_persistence_failed");
    assert.equal(
      values.get("Agent Artifact Reference"),
      "s3://phase49-artifacts-example/phase49/artifacts/123e4567-e89b-42d3-a456-426614174000.json",
    );
  });

  void it("fails closed when exact read-back does not match", async () => {
    const client = new FakeCompatibilityClient(issueFixture());
    client.mutateAfterWrite = true;
    const verifier = new RedminePhase49FirstWriteCompatibilityVerifier({
      client,
      allowedProjectIds: [414],
    });

    await assert.rejects(
      verifier.verify({
        fixtureIssueId: 9001,
        representativeArtifactReference: "s3://phase49-artifacts-example/phase49/artifacts/123e4567-e89b-42d3-a456-426614174000.json",
      }),
      /read-back mismatch/u,
    );
  });

  void it("rejects a fixture outside allowed projects before mutation", async () => {
    const client = new FakeCompatibilityClient({ ...issueFixture(), project: { id: 999, name: "Other" } });
    const verifier = new RedminePhase49FirstWriteCompatibilityVerifier({
      client,
      allowedProjectIds: [414],
    });

    await assert.rejects(
      verifier.verify({ fixtureIssueId: 9001, representativeArtifactReference: "s3://bucket/key" }),
      /outside allowed projects/u,
    );
    assert.equal(client.writeCount, 0);
  });
});

class FakeCompatibilityClient implements Phase49CompatibilityRedmineClient {
  issue: RedmineIssueRecord;
  writeCount = 0;
  mutateAfterWrite = false;

  constructor(issue: RedmineIssueRecord) {
    this.issue = issue;
  }

  getIssue(_issueId: number): Promise<RedmineIssueRecord> {
    return Promise.resolve(this.issue);
  }

  updateIssueCustomFields(_issueId: number, writes: readonly CustomFieldWrite[]): Promise<void> {
    this.writeCount += 1;
    const byId = new Map(writes.map((entry) => [entry.id, entry.value]));
    this.issue = {
      ...this.issue,
      customFields: this.issue.customFields.map((field) => ({
        ...field,
        value: byId.get(field.id) ?? field.value,
      })),
    };
    if (this.mutateAfterWrite) {
      this.issue = {
        ...this.issue,
        customFields: this.issue.customFields.map((field) =>
          field.name === "Agent Execution Outcome"
            ? { ...field, value: "wrong" }
            : field,
        ),
      };
    }
    return Promise.resolve();
  }
}

function issueFixture(): RedmineIssueRecord {
  return {
    id: 9001,
    project: { id: 414, name: "Redmine" },
    tracker: { id: 2, name: "Feature" },
    subject: "Phase 49 compatibility fixture",
    description: "Disposable verification fixture",
    customFields: [
      { id: 11, name: "Agent Execution Lifecycle", value: "" },
      { id: 23, name: "Agent Execution Outcome", value: "" },
      { id: 24, name: "Agent Artifact Reference", value: "" },
    ],
    updatedOn: "2026-09-21T00:00:00Z",
    journals: [],
    relations: [],
    children: [],
  };
}
