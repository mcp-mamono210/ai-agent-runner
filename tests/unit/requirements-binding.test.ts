import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CanonicalRequirementsRevalidator } from "../../src/agent-brief/requirements-binding.js";
import {
  calculateAgentBriefRequirementsFingerprintCompat,
  projectAgentBriefGenerationInputCompat,
  type AgentBriefGenerationInput,
} from "../../src/agent-brief/requirements-fingerprint-compat.js";
import type { ValidatedHandoff } from "../../src/controller/types.js";
import type { RedmineIssueRecord } from "../../src/redmine/domain.js";

const CANONICAL_FINGERPRINT =
  "sha256:421a17880d514fa7f8446f3391e418f5b8b114f83deab95bc8d3417f715260fe";

function canonicalGenerationInput(): AgentBriefGenerationInput {
  return {
    format_version: 1,
    source: {
      redmine_issue_id: 5368,
      source_updated_on: "2026-09-07T00:00:00Z",
      project: { id: 414, name: "Redmine" },
      tracker: { id: 2, name: "Feature" },
      fixed_version: { id: 29, name: "0.3.0" },
      subject: "Requirements fingerprint",
      description: "Same requirements produce the same fingerprint.",
    },
    requirement_custom_fields: [],
    journal_notes: [],
    relations: [],
    children: [],
    projection: {
      requirement_custom_field_ids: [],
      redacted_paths: [],
      truncated_paths: [],
      omitted: {
        requirement_custom_fields: 0,
        journal_notes: 0,
        relations: 0,
        children: 0,
      },
    },
  };
}

function issueFixture(): RedmineIssueRecord {
  return {
    id: 9001,
    project: { id: 414, name: "Redmine" },
    tracker: { id: 2, name: "Feature" },
    fixedVersion: { id: 33, name: "0.4.0" },
    subject: "Implement controller",
    description: "Use the approved requirements.",
    customFields: [
      { id: 21, name: "Requirement", value: "preserve deterministic semantics" },
    ],
    updatedOn: "2026-09-17T00:00:00Z",
    journals: [],
    relations: [],
    children: [],
  };
}

void describe("Phase 39 requirements compatibility binding", () => {
  void it("matches the canonical Phase 39 SHA-256 test vector", () => {
    assert.equal(
      calculateAgentBriefRequirementsFingerprintCompat(canonicalGenerationInput()),
      CANONICAL_FINGERPRINT,
    );
  });

  void it("returns current and stale using the canonical projection semantics", async () => {
    const issue = issueFixture();
    const approved = calculateAgentBriefRequirementsFingerprintCompat(
      projectAgentBriefGenerationInputCompat(issue, {
        requirementCustomFieldIds: [21],
      }),
    );
    const handoff: ValidatedHandoff = {
      issueId: issue.id,
      repository: "mcp-mamono210/redmine",
      approvedRequirementsFingerprint: approved,
      opaque: {},
    };
    const revalidator = new CanonicalRequirementsRevalidator({
      requirementCustomFieldIds: [21],
    });

    const current = await revalidator.revalidate(
      { issueId: issue.id, projectId: issue.project.id, lifecycle: "Ready for Agent", raw: issue },
      handoff,
    );
    assert.equal(current.kind, "current");

    const changed: RedmineIssueRecord = {
      ...issue,
      subject: "Changed requirements",
    };
    const stale = await revalidator.revalidate(
      { issueId: changed.id, projectId: changed.project.id, lifecycle: "Ready for Agent", raw: changed },
      handoff,
    );
    assert.equal(stale.kind, "stale");
  });
});
