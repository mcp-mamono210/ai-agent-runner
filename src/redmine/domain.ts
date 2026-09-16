export interface RedmineNamedResource {
  readonly id: number;
  readonly name: string;
}

export interface RedmineCustomField {
  readonly id: number;
  readonly name: string;
  readonly value: string | readonly string[];
}

export interface RedmineJournal {
  readonly id: number;
  readonly notes: string;
  readonly createdOn: string;
}

export interface RedmineIssueRelation {
  readonly id: number;
  readonly issueId: number;
  readonly issueToId: number;
  readonly relationType: string;
  readonly delay?: number;
}

export interface RedmineIssueChild {
  readonly id: number;
  readonly subject: string;
  readonly tracker?: RedmineNamedResource;
}

export interface RedmineIssueRecord {
  readonly id: number;
  readonly project: RedmineNamedResource;
  readonly tracker: RedmineNamedResource;
  readonly fixedVersion?: RedmineNamedResource;
  readonly subject: string;
  readonly description: string;
  readonly customFields: readonly RedmineCustomField[];
  readonly updatedOn: string;
  readonly journals: readonly RedmineJournal[];
  readonly relations: readonly RedmineIssueRelation[];
  readonly children: readonly RedmineIssueChild[];
}

export interface RedmineIssueListItem {
  readonly id: number;
  readonly projectId: number;
}

export interface CustomFieldWrite {
  readonly id: number;
  readonly value: string;
}

export function findUniqueCustomField(
  issue: RedmineIssueRecord,
  exactName: string,
): RedmineCustomField {
  const matches = issue.customFields.filter((field) => field.name === exactName);
  if (matches.length === 0) {
    throw new Error(`Required Redmine custom field is missing: ${exactName}`);
  }
  if (matches.length > 1) {
    throw new Error(`Required Redmine custom field is ambiguous: ${exactName}`);
  }
  return matches[0]!;
}

export function scalarCustomFieldValue(field: RedmineCustomField): string {
  if (typeof field.value !== "string") {
    throw new Error(`Redmine custom field must be scalar: ${field.name}`);
  }
  return field.value;
}
