import { execFile } from "node:child_process";
import { resolve } from "node:path";

import type {
  HandoffValidationResult,
  HandoffValidator,
  ReFetchedIssue,
  ValidatedHandoff,
} from "../controller/types.js";
import {
  findUniqueCustomField,
  scalarCustomFieldValue,
  type RedmineIssueRecord,
} from "../redmine/domain.js";

const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const APPROVER_PATTERN = /^redmine-user:[1-9]\d*$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const FIELD_NAMES = {
  lifecycle: "Agent Brief Lifecycle",
  approvedBy: "Brief Approved By",
  approvedAt: "Brief Approved At",
  approvedBriefRevision: "Approved Brief Revision",
  approvedPersistedRevision: "Approved Persisted Revision",
  approvedRequirementsFingerprint: "Approved Req Fingerprint",
} as const;

export interface ApprovedBriefReference {
  readonly repository: string;
  readonly issueId: number;
  readonly briefRevision: number;
  readonly persistedRevision: string;
  readonly requirementsFingerprint: string;
}

export interface ApprovedBriefVerifier {
  verify(reference: ApprovedBriefReference): Promise<void>;
}

export interface LocalGitApprovedBriefVerifierOptions {
  readonly repositoryRoot: string;
  readonly repository: string;
  readonly canonicalBranch?: string;
}

export interface ValidatedApprovalEvidence {
  readonly approverIdentity: string;
  readonly approvedAt: string;
  readonly briefRevision: number;
  readonly persistedRevision: string;
  readonly requirementsFingerprint: string;
}

export class LocalGitApprovedBriefVerifier implements ApprovedBriefVerifier {
  readonly #repositoryRoot: string;
  readonly #repository: string;
  readonly #canonicalBranch: string;

  constructor(options: LocalGitApprovedBriefVerifierOptions) {
    if (options.repositoryRoot.trim() === "") {
      throw new Error("AGENT_BRIEF_REPOSITORY_ROOT is required");
    }
    if (options.repository.trim() === "") {
      throw new Error("AGENT_BRIEF_REPOSITORY is required");
    }
    const canonicalBranch = options.canonicalBranch?.trim() || "main";
    if (canonicalBranch.startsWith("-")) {
      throw new Error("AGENT_BRIEF_CANONICAL_BRANCH must not start with '-'");
    }
    this.#repositoryRoot = resolve(options.repositoryRoot);
    this.#repository = options.repository;
    this.#canonicalBranch = canonicalBranch;
  }

  async verify(reference: ApprovedBriefReference): Promise<void> {
    if (reference.repository !== this.#repository) {
      throw new Error("configured Brief repository does not match handoff repository");
    }

    const artifactPath =
      `docs/agent-briefs/${reference.issueId}/revisions/${reference.briefRevision}.md`;
    const lsTree = await runGit(this.#repositoryRoot, [
      "ls-tree",
      this.#canonicalBranch,
      "--",
      artifactPath,
    ]);
    const match = /^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/u.exec(lsTree.trim());
    if (match === null || match[2] !== artifactPath) {
      throw new Error("approved Agent Brief artifact is not reachable from canonical branch");
    }

    const blobId = match[1]!;
    if (blobId !== reference.persistedRevision) {
      throw new Error("approved persisted revision does not match canonical Brief blob");
    }

    const markdown = await runGit(this.#repositoryRoot, ["show", blobId]);
    const frontmatter = parseFrontmatter(markdown);

    if (frontmatter.format_version !== "1") {
      throw new Error("approved Agent Brief format_version is not 1");
    }
    if (frontmatter.redmine_issue_id !== String(reference.issueId)) {
      throw new Error("approved Agent Brief Issue identity mismatch");
    }
    if (frontmatter.repository !== reference.repository) {
      throw new Error("approved Agent Brief repository identity mismatch");
    }
    if (frontmatter.brief_revision !== String(reference.briefRevision)) {
      throw new Error("approved Agent Brief revision identity mismatch");
    }
    if (frontmatter.requirements_fingerprint !== reference.requirementsFingerprint) {
      throw new Error("approved Agent Brief requirements fingerprint mismatch");
    }
  }
}

export class Phase46HandoffValidator implements HandoffValidator {
  readonly #repository: string;
  readonly #approvedBriefVerifier: ApprovedBriefVerifier;

  constructor(input: {
    readonly repository: string;
    readonly approvedBriefVerifier: ApprovedBriefVerifier;
  }) {
    if (input.repository.trim() === "") {
      throw new Error("repository must not be blank");
    }
    this.#repository = input.repository;
    this.#approvedBriefVerifier = input.approvedBriefVerifier;
  }

  async validate(issue: ReFetchedIssue): Promise<HandoffValidationResult> {
    try {
      const redmineIssue = requireRedmineIssueRecord(issue);
      const lifecycle = readScalar(redmineIssue, FIELD_NAMES.lifecycle);
      if (lifecycle !== "Ready for Agent") {
        return { ok: false, diagnostic: "Agent Brief lifecycle is not Ready for Agent" };
      }

      const approval = parseApprovalEvidence(redmineIssue);
      const reference: ApprovedBriefReference = {
        repository: this.#repository,
        issueId: redmineIssue.id,
        briefRevision: approval.briefRevision,
        persistedRevision: approval.persistedRevision,
        requirementsFingerprint: approval.requirementsFingerprint,
      };

      await this.#approvedBriefVerifier.verify(reference);

      const handoff: ValidatedHandoff = {
        issueId: redmineIssue.id,
        repository: this.#repository,
        approvedRequirementsFingerprint: approval.requirementsFingerprint,
        approval: {
          approverIdentity: approval.approverIdentity,
          approvedAt: approval.approvedAt,
          briefRevision: approval.briefRevision,
          persistedRevision: approval.persistedRevision,
        },
        opaque: {
          approverIdentity: approval.approverIdentity,
          approvedAt: approval.approvedAt,
          approvedBriefRevision: approval.briefRevision,
          approvedPersistedRevision: approval.persistedRevision,
        },
      };
      return { ok: true, handoff };
    } catch (error) {
      return {
        ok: false,
        diagnostic: safeDiagnostic(error, "Phase 46 handoff validation failed"),
      };
    }
  }
}

function parseApprovalEvidence(issue: RedmineIssueRecord): ValidatedApprovalEvidence {
  const approverIdentity = readScalar(issue, FIELD_NAMES.approvedBy);
  const approvedAt = readScalar(issue, FIELD_NAMES.approvedAt);
  const briefRevisionRaw = readScalar(issue, FIELD_NAMES.approvedBriefRevision);
  const persistedRevision = readScalar(issue, FIELD_NAMES.approvedPersistedRevision);
  const requirementsFingerprint = readScalar(
    issue,
    FIELD_NAMES.approvedRequirementsFingerprint,
  );

  if (!APPROVER_PATTERN.test(approverIdentity)) {
    throw new Error("Brief Approved By must use redmine-user:<positive-user-id>");
  }
  if (!RFC3339_PATTERN.test(approvedAt) || Number.isNaN(Date.parse(approvedAt))) {
    throw new Error("Brief Approved At must be an RFC 3339 timestamp with timezone");
  }
  if (!POSITIVE_INTEGER_PATTERN.test(briefRevisionRaw)) {
    throw new Error("Approved Brief Revision must be a positive base-10 integer");
  }
  const briefRevision = Number(briefRevisionRaw);
  if (!Number.isSafeInteger(briefRevision)) {
    throw new Error("Approved Brief Revision is outside the supported integer range");
  }
  if (persistedRevision.trim() === "") {
    throw new Error("Approved Persisted Revision must not be blank");
  }
  if (!FINGERPRINT_PATTERN.test(requirementsFingerprint)) {
    throw new Error(
      "Approved Req Fingerprint must use sha256:<64 lowercase hexadecimal characters>",
    );
  }

  return {
    approverIdentity,
    approvedAt,
    briefRevision,
    persistedRevision,
    requirementsFingerprint,
  };
}

function readScalar(issue: RedmineIssueRecord, name: string): string {
  return scalarCustomFieldValue(findUniqueCustomField(issue, name));
}

function requireRedmineIssueRecord(issue: ReFetchedIssue): RedmineIssueRecord {
  if (typeof issue.raw !== "object" || issue.raw === null || Array.isArray(issue.raw)) {
    throw new Error("re-fetched Issue does not contain a Redmine issue projection");
  }
  const candidate = issue.raw as Partial<RedmineIssueRecord>;
  if (
    candidate.id !== issue.issueId ||
    candidate.project?.id !== issue.projectId ||
    !Array.isArray(candidate.customFields)
  ) {
    throw new Error("re-fetched Issue projection identity mismatch");
  }
  return candidate as RedmineIssueRecord;
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  if (lines[0] !== "---") {
    throw new Error("approved Agent Brief frontmatter is missing");
  }
  const closing = lines.indexOf("---", 1);
  if (closing < 0) {
    throw new Error("approved Agent Brief frontmatter is unterminated");
  }

  const output: Record<string, string> = {};
  for (const line of lines.slice(1, closing)) {
    if (line.trim() === "") {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error("approved Agent Brief frontmatter contains unsupported syntax");
    }
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    if (key in output) {
      throw new Error(`approved Agent Brief frontmatter contains duplicate key: ${key}`);
    }
    output[key] = value;
  }
  return output;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function runGit(repositoryRoot: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["-C", repositoryRoot, ...args],
      { encoding: "utf8", maxBuffer: 1_048_576 },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(new Error("local Git Brief verification failed", { cause: error }));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

function safeDiagnostic(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return fallback;
}
