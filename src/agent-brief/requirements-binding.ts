import type {
  ReFetchedIssue,
  RequirementsRevalidationResult,
  RequirementsRevalidator,
  ValidatedHandoff,
} from "../controller/types.js";
import type { RedmineIssueRecord } from "../redmine/domain.js";
import {
  calculateAgentBriefRequirementsFingerprintCompat,
  projectAgentBriefGenerationInputCompat,
} from "./requirements-fingerprint-compat.js";

export class CanonicalRequirementsRevalidator implements RequirementsRevalidator {
  readonly #requirementCustomFieldIds: readonly number[];
  readonly #configuredSecrets: readonly string[];

  constructor(input: {
    readonly requirementCustomFieldIds: readonly number[];
    readonly configuredSecrets?: readonly string[];
  }) {
    this.#requirementCustomFieldIds = [...input.requirementCustomFieldIds];
    this.#configuredSecrets = [...(input.configuredSecrets ?? [])];
  }

  revalidate(
    issue: ReFetchedIssue,
    handoff: ValidatedHandoff,
  ): Promise<RequirementsRevalidationResult> {
    try {
      const redmineIssue = requireRedmineIssueRecord(issue);
      const generationInput = projectAgentBriefGenerationInputCompat(redmineIssue, {
        requirementCustomFieldIds: this.#requirementCustomFieldIds,
        configuredSecrets: this.#configuredSecrets,
      });
      const currentFingerprint =
        calculateAgentBriefRequirementsFingerprintCompat(generationInput);

      if (currentFingerprint === handoff.approvedRequirementsFingerprint) {
        return Promise.resolve({ kind: "current", currentFingerprint });
      }

      return Promise.resolve({
        kind: "stale",
        currentFingerprint,
        approvedFingerprint: handoff.approvedRequirementsFingerprint,
        diagnostic:
          "current requirements fingerprint does not match approved fingerprint",
      });
    } catch (error) {
      return Promise.resolve({
        kind: "failed",
        diagnostic: safeDiagnostic(
          error,
          "requirements fingerprint generation failed",
        ),
      });
    }
  }
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

function safeDiagnostic(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return fallback;
}
