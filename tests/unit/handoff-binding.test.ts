import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import {
  LocalGitApprovedBriefVerifier,
  Phase46HandoffValidator,
} from "../../src/agent-brief/handoff-binding.js";
import type { RedmineIssueRecord } from "../../src/redmine/domain.js";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function createRepository(): {
  readonly root: string;
  readonly blobId: string;
} {
  const root = mkdtempSync(join(tmpdir(), "runner-brief-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  const directory = join(root, "docs", "agent-briefs", "9001", "revisions");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "2.md"),
    `---\nformat_version: 1\nredmine_issue_id: 9001\nrepository: mcp-mamono210/redmine\nbrief_revision: 2\nrequirements_fingerprint: ${FINGERPRINT}\n---\n\n## Agent Brief\n`,
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "brief"]);
  const tree = git(root, [
    "ls-tree",
    "main",
    "--",
    "docs/agent-briefs/9001/revisions/2.md",
  ]).trim();
  const match = /\bblob\s+([0-9a-f]+)\t/u.exec(tree);
  if (match === null) {
    throw new Error("fixture blob ID was not found");
  }
  return { root, blobId: match[1]! };
}

function issueFixture(blobId: string): RedmineIssueRecord {
  return {
    id: 9001,
    project: { id: 414, name: "Redmine" },
    tracker: { id: 2, name: "Feature" },
    subject: "Approved issue",
    description: "Approved issue description",
    customFields: [
      { id: 1, name: "Agent Brief Lifecycle", value: "Ready for Agent" },
      { id: 2, name: "Brief Approved By", value: "redmine-user:3" },
      { id: 3, name: "Brief Approved At", value: "2026-09-17T00:00:00Z" },
      { id: 4, name: "Approved Brief Revision", value: "2" },
      { id: 5, name: "Approved Persisted Revision", value: blobId },
      { id: 6, name: "Approved Req Fingerprint", value: FINGERPRINT },
    ],
    updatedOn: "2026-09-17T00:00:00Z",
    journals: [],
    relations: [],
    children: [],
  };
}

void describe("Phase 46 handoff binding", () => {
  void it("verifies exact canonical-branch Brief blob and frontmatter identity", async () => {
    const fixture = createRepository();
    try {
      const verifier = new LocalGitApprovedBriefVerifier({
        repositoryRoot: fixture.root,
        repository: "mcp-mamono210/redmine",
        canonicalBranch: "main",
      });
      const validator = new Phase46HandoffValidator({
        repository: "mcp-mamono210/redmine",
        approvedBriefVerifier: verifier,
      });
      const issue = issueFixture(fixture.blobId);

      const result = await validator.validate({
        issueId: issue.id,
        projectId: issue.project.id,
        lifecycle: "Ready for Agent",
        raw: issue,
      });

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.handoff.repository, "mcp-mamono210/redmine");
        assert.equal(result.handoff.approvedRequirementsFingerprint, FINGERPRINT);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  void it("fails closed when persisted revision does not match the canonical blob", async () => {
    const fixture = createRepository();
    try {
      const verifier = new LocalGitApprovedBriefVerifier({
        repositoryRoot: fixture.root,
        repository: "mcp-mamono210/redmine",
      });
      const validator = new Phase46HandoffValidator({
        repository: "mcp-mamono210/redmine",
        approvedBriefVerifier: verifier,
      });
      const issue = issueFixture("deadbeef");
      const result = await validator.validate({
        issueId: issue.id,
        projectId: issue.project.id,
        lifecycle: "Ready for Agent",
        raw: issue,
      });
      assert.equal(result.ok, false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
