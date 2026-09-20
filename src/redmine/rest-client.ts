import type {
  CustomFieldWrite,
  RedmineCustomField,
  RedmineIssueChild,
  RedmineIssueListItem,
  RedmineIssueRecord,
  RedmineIssueRelation,
  RedmineJournal,
  RedmineNamedResource,
} from "./domain.js";

const DEFAULT_TIMEOUT_MS = 10_000;

type FetchLike = typeof fetch;

export interface RedmineRestClientOptions {
  readonly baseUrl: string;
  readonly readApiKey: string;
  readonly writeApiKey: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
}

export class RedmineRestClient {
  readonly #baseUrl: URL;
  readonly #readApiKey: string;
  readonly #writeApiKey: string;
  readonly #timeoutMs: number;
  readonly #fetchImpl: FetchLike;

  constructor(options: RedmineRestClientOptions) {
    if (options.baseUrl.trim() === "") {
      throw new Error("REDMINE_URL is required");
    }
    if (options.readApiKey.trim() === "") {
      throw new Error("REDMINE_API_KEY is required");
    }
    if (options.writeApiKey.trim() === "") {
      throw new Error("REDMINE_WRITE_API_KEY is required");
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Redmine timeout must be a positive safe integer");
    }

    const base = new URL(options.baseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new Error("REDMINE_URL must use http or https");
    }

    this.#baseUrl = new URL(base.href.endsWith("/") ? base.href : `${base.href}/`);
    this.#readApiKey = options.readApiKey;
    this.#writeApiKey = options.writeApiKey;
    this.#timeoutMs = timeoutMs;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async listReadyForAgentCandidates(input: {
    readonly projectId: number;
    readonly lifecycleFieldId: number;
    readonly lifecycleValue: string;
    readonly limit: 1;
  }): Promise<readonly RedmineIssueListItem[]> {
    assertPositiveInteger(input.projectId, "projectId");
    assertPositiveInteger(input.lifecycleFieldId, "lifecycleFieldId");

    const params = new URLSearchParams({
      project_id: String(input.projectId),
      status_id: "*",
      limit: String(input.limit),
      sort: "id:asc",
      [`cf_${input.lifecycleFieldId}`]: input.lifecycleValue,
    });

    const payload = await this.#requestJson(
      "GET",
      `/issues.json?${params.toString()}`,
      "read",
    );
    const root = asRecord(payload, "issues response");
    const issues = asArray(root.issues, "issues response.issues");

    return issues.map((entry, index) => {
      const issue = asRecord(entry, `issues[${index}]`);
      const project = asRecord(issue.project, `issues[${index}].project`);
      return {
        id: positiveInteger(issue.id, `issues[${index}].id`),
        projectId: positiveInteger(project.id, `issues[${index}].project.id`),
      };
    });
  }

  async listIssuesByCustomField(input: {
    readonly projectId: number;
    readonly customFieldId: number;
    readonly value: string;
    readonly limit: number;
  }): Promise<readonly RedmineIssueListItem[]> {
    assertPositiveInteger(input.projectId, "projectId");
    assertPositiveInteger(input.customFieldId, "customFieldId");
    assertPositiveInteger(input.limit, "limit");
    if (input.limit > 100) {
      throw new Error("Redmine custom-field query limit must not exceed 100");
    }
    if (input.value.trim() === "") {
      throw new Error("Redmine custom-field query value must not be blank");
    }

    const params = new URLSearchParams({
      project_id: String(input.projectId),
      status_id: "*",
      limit: String(input.limit),
      sort: "id:asc",
      [`cf_${input.customFieldId}`]: input.value,
    });
    const payload = await this.#requestJson(
      "GET",
      `/issues.json?${params.toString()}`,
      "read",
    );
    const root = asRecord(payload, "issues response");
    if (root.total_count !== undefined) {
      const totalCount = positiveOrZeroInteger(root.total_count, "issues response.total_count");
      if (totalCount > input.limit) {
        throw new Error("Redmine custom-field query exceeded the bounded recovery limit");
      }
    }
    const issues = asArray(root.issues, "issues response.issues");
    return issues.map((entry, index) => {
      const issue = asRecord(entry, `issues[${index}]`);
      const project = asRecord(issue.project, `issues[${index}].project`);
      return {
        id: positiveInteger(issue.id, `issues[${index}].id`),
        projectId: positiveInteger(project.id, `issues[${index}].project.id`),
      };
    });
  }

  async getIssue(issueId: number): Promise<RedmineIssueRecord> {
    assertPositiveInteger(issueId, "issueId");
    const params = new URLSearchParams({ include: "journals,relations,children" });
    const payload = await this.#requestJson(
      "GET",
      `/issues/${encodeURIComponent(String(issueId))}.json?${params.toString()}`,
      "read",
    );
    const root = asRecord(payload, "issue response");
    return parseIssue(asRecord(root.issue, "issue response.issue"));
  }

  async updateIssueCustomFields(
    issueId: number,
    customFields: readonly CustomFieldWrite[],
  ): Promise<void> {
    assertPositiveInteger(issueId, "issueId");
    if (customFields.length === 0) {
      throw new Error("customFields must not be empty");
    }

    const ids = customFields.map((field) => field.id);
    for (const id of ids) {
      assertPositiveInteger(id, "custom field id");
    }
    if (new Set(ids).size !== ids.length) {
      throw new Error("custom field IDs must be unique");
    }

    await this.#requestVoid(
      "PUT",
      `/issues/${encodeURIComponent(String(issueId))}.json`,
      "write",
      {
        issue: {
          custom_fields: customFields,
        },
      },
    );
  }

  async #requestJson(
    method: "GET" | "PUT",
    path: string,
    credential: "read" | "write",
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.#request(method, path, credential, body);
    const text = await response.text();
    if (text === "") {
      throw new Error(`Redmine returned an empty JSON response: ${method} ${stripQuery(path)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Redmine returned invalid JSON: ${method} ${stripQuery(path)}`);
    }
  }

  async #requestVoid(
    method: "GET" | "PUT",
    path: string,
    credential: "read" | "write",
    body?: unknown,
  ): Promise<void> {
    await this.#request(method, path, credential, body);
  }

  async #request(
    method: "GET" | "PUT",
    path: string,
    credential: "read" | "write",
    body?: unknown,
  ): Promise<Response> {
    const requestUrl = new URL(path.replace(/^\/+/, ""), this.#baseUrl);
    const apiKey = credential === "read" ? this.#readApiKey : this.#writeApiKey;

    let response: Response;
    try {
      response = await this.#fetchImpl(requestUrl, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          "X-Redmine-API-Key": apiKey,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `Redmine request failed before receiving a response: ${method} ${stripQuery(path)}`,
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new Error(
        `Redmine request failed: ${method} ${stripQuery(path)} -> HTTP ${response.status}`,
      );
    }

    return response;
  }
}

function parseIssue(raw: Record<string, unknown>): RedmineIssueRecord {
  return {
    id: positiveInteger(raw.id, "issue.id"),
    project: parseNamedResource(raw.project, "issue.project"),
    tracker: parseNamedResource(raw.tracker, "issue.tracker"),
    ...(raw.fixed_version === undefined || raw.fixed_version === null
      ? {}
      : { fixedVersion: parseNamedResource(raw.fixed_version, "issue.fixed_version") }),
    subject: stringValue(raw.subject, "issue.subject"),
    description:
      raw.description === undefined || raw.description === null
        ? ""
        : stringValue(raw.description, "issue.description"),
    customFields: asArray(raw.custom_fields ?? [], "issue.custom_fields").map(
      parseCustomField,
    ),
    updatedOn: stringValue(raw.updated_on, "issue.updated_on"),
    journals: asArray(raw.journals ?? [], "issue.journals").map(parseJournal),
    relations: asArray(raw.relations ?? [], "issue.relations").map(parseRelation),
    children: asArray(raw.children ?? [], "issue.children").map(parseChild),
  };
}

function parseNamedResource(raw: unknown, path: string): RedmineNamedResource {
  const record = asRecord(raw, path);
  return {
    id: positiveInteger(record.id, `${path}.id`),
    name: stringValue(record.name, `${path}.name`),
  };
}

function parseCustomField(raw: unknown, index: number): RedmineCustomField {
  const path = `issue.custom_fields[${index}]`;
  const record = asRecord(raw, path);
  const value = record.value;
  return {
    id: positiveInteger(record.id, `${path}.id`),
    name: stringValue(record.name, `${path}.name`),
    value: Array.isArray(value)
      ? value.map((entry, valueIndex) =>
          stringValue(entry, `${path}.value[${valueIndex}]`),
        )
      : stringValue(value ?? "", `${path}.value`),
  };
}

function parseJournal(raw: unknown, index: number): RedmineJournal {
  const path = `issue.journals[${index}]`;
  const record = asRecord(raw, path);
  return {
    id: positiveInteger(record.id, `${path}.id`),
    notes: stringValue(record.notes ?? "", `${path}.notes`),
    createdOn: stringValue(record.created_on, `${path}.created_on`),
  };
}

function parseRelation(raw: unknown, index: number): RedmineIssueRelation {
  const path = `issue.relations[${index}]`;
  const record = asRecord(raw, path);
  return {
    id: positiveInteger(record.id, `${path}.id`),
    issueId: positiveInteger(record.issue_id, `${path}.issue_id`),
    issueToId: positiveInteger(record.issue_to_id, `${path}.issue_to_id`),
    relationType: stringValue(record.relation_type, `${path}.relation_type`),
    ...(record.delay === undefined || record.delay === null
      ? {}
      : { delay: integerValue(record.delay, `${path}.delay`) }),
  };
}

function parseChild(raw: unknown, index: number): RedmineIssueChild {
  const path = `issue.children[${index}]`;
  const record = asRecord(raw, path);
  return {
    id: positiveInteger(record.id, `${path}.id`),
    subject: stringValue(record.subject, `${path}.subject`),
    ...(record.tracker === undefined || record.tracker === null
      ? {}
      : { tracker: parseNamedResource(record.tracker, `${path}.tracker`) }),
  };
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Redmine response at ${path}: expected object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid Redmine response at ${path}: expected array`);
  }
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid Redmine response at ${path}: expected string`);
  }
  return value;
}

function positiveOrZeroInteger(value: unknown, path: string): number {
  const parsed = integerValue(value, path);
  if (parsed < 0) {
    throw new Error(`Invalid Redmine response at ${path}: expected non-negative integer`);
  }
  return parsed;
}

function positiveInteger(value: unknown, path: string): number {
  const parsed = integerValue(value, path);
  if (parsed <= 0) {
    throw new Error(`Invalid Redmine response at ${path}: expected positive integer`);
  }
  return parsed;
}

function integerValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid Redmine response at ${path}: expected safe integer`);
  }
  return value;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function stripQuery(path: string): string {
  return path.split("?", 1)[0] ?? path;
}
