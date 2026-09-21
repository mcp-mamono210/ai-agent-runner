export const PHASE50_CONFORMANCE_CLASSIFICATIONS = [
  "compatible",
  "incompatible",
  "unsupported",
  "different-contract-affecting",
  "different-contract-neutral",
] as const;

export type Phase50ConformanceClassification =
  (typeof PHASE50_CONFORMANCE_CLASSIFICATIONS)[number];

export const PHASE50_COVERAGE_ROUTES = ["A", "B", "C", "D", "E"] as const;
export type Phase50CoverageRoute = (typeof PHASE50_COVERAGE_ROUTES)[number];

export interface Phase50ConformanceFinding {
  readonly id: string;
  readonly surface: "s3" | "sandbox";
  readonly requirement: string;
  readonly classification: Phase50ConformanceClassification;
  readonly evidence: readonly string[];
  readonly coverageRoute?: Phase50CoverageRoute;
  readonly coverageExecuted?: boolean;
  readonly coverageEvidence?: readonly string[];
}

export interface Phase50EnvironmentConformanceRecord {
  readonly schemaVersion: 1;
  readonly testedGitRevision: string;
  readonly generatedAt: string;
  readonly findings: readonly Phase50ConformanceFinding[];
}

export function validatePhase50ConformanceFinding(
  finding: Phase50ConformanceFinding,
): void {
  if (finding.id.trim() === "") {
    throw new Error("Phase 50 conformance finding id must not be blank");
  }
  if (finding.requirement.trim() === "") {
    throw new Error(`Phase 50 conformance requirement is blank: ${finding.id}`);
  }
  if (finding.evidence.length === 0 || finding.evidence.some((entry) => entry.trim() === "")) {
    throw new Error(`Phase 50 conformance evidence is missing: ${finding.id}`);
  }

  switch (finding.classification) {
    case "compatible":
      if (finding.coverageRoute !== undefined) {
        throw new Error(`compatible finding must not declare alternate coverage: ${finding.id}`);
      }
      return;
    case "different-contract-neutral":
      if (finding.coverageRoute !== "E") {
        throw new Error(`contract-neutral difference must use coverage route E: ${finding.id}`);
      }
      if (finding.coverageExecuted !== true) {
        throw new Error(`contract-neutral evidence has not been closed: ${finding.id}`);
      }
      requireCoverageEvidence(finding);
      return;
    case "incompatible":
    case "unsupported":
    case "different-contract-affecting":
      if (
        finding.coverageRoute !== "A" &&
        finding.coverageRoute !== "B" &&
        finding.coverageRoute !== "C" &&
        finding.coverageRoute !== "D"
      ) {
        throw new Error(`contract-affecting finding lacks coverage route A-D: ${finding.id}`);
      }
      if (finding.coverageExecuted !== true) {
        throw new Error(`alternate coverage is planned but not executed: ${finding.id}`);
      }
      requireCoverageEvidence(finding);
  }
}

export function assertPhase50EnvironmentCoverageClosed(
  findings: readonly Phase50ConformanceFinding[],
): void {
  if (findings.length === 0) {
    throw new Error("Phase 50 conformance report must contain findings");
  }
  const ids = new Set<string>();
  for (const finding of findings) {
    if (ids.has(finding.id)) {
      throw new Error(`duplicate Phase 50 conformance finding id: ${finding.id}`);
    }
    ids.add(finding.id);
    validatePhase50ConformanceFinding(finding);
  }
}

export function parsePhase50ConformanceRecord(value: unknown): Phase50EnvironmentConformanceRecord {
  const root = record(value, "Phase 50 conformance record");
  if (root.schemaVersion !== 1) {
    throw new Error("Phase 50 conformance record schemaVersion must be 1");
  }
  const testedGitRevision = text(root.testedGitRevision, "testedGitRevision");
  if (!/^[0-9a-f]{40,64}$/u.test(testedGitRevision)) {
    throw new Error("testedGitRevision must be a lowercase full Git revision");
  }
  const generatedAt = text(root.generatedAt, "generatedAt");
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new Error("generatedAt must be an ISO-compatible timestamp");
  }
  if (!Array.isArray(root.findings)) {
    throw new Error("findings must be an array");
  }
  const findings = root.findings.map((entry, index) => parseFinding(entry, index));
  const parsed = Object.freeze({
    schemaVersion: 1 as const,
    testedGitRevision,
    generatedAt,
    findings: Object.freeze(findings),
  });
  assertPhase50EnvironmentCoverageClosed(parsed.findings);
  return parsed;
}

function parseFinding(value: unknown, index: number): Phase50ConformanceFinding {
  const item = record(value, `findings[${index}]`);
  const surface = item.surface;
  if (surface !== "s3" && surface !== "sandbox") {
    throw new Error(`findings[${index}].surface is invalid`);
  }
  const classification = item.classification;
  if (!isClassification(classification)) {
    throw new Error(`findings[${index}].classification is invalid`);
  }
  const coverageRoute = item.coverageRoute;
  if (coverageRoute !== undefined && !isCoverageRoute(coverageRoute)) {
    throw new Error(`findings[${index}].coverageRoute is invalid`);
  }
  const finding: Phase50ConformanceFinding = Object.freeze({
    id: text(item.id, `findings[${index}].id`),
    surface,
    requirement: text(item.requirement, `findings[${index}].requirement`),
    classification,
    evidence: Object.freeze(textArray(item.evidence, `findings[${index}].evidence`)),
    ...(coverageRoute === undefined ? {} : { coverageRoute }),
    ...(item.coverageExecuted === undefined
      ? {}
      : { coverageExecuted: booleanValue(item.coverageExecuted, `findings[${index}].coverageExecuted`) }),
    ...(item.coverageEvidence === undefined
      ? {}
      : {
          coverageEvidence: Object.freeze(
            textArray(item.coverageEvidence, `findings[${index}].coverageEvidence`),
          ),
        }),
  });
  validatePhase50ConformanceFinding(finding);
  return finding;
}

function requireCoverageEvidence(finding: Phase50ConformanceFinding): void {
  if (
    finding.coverageEvidence === undefined ||
    finding.coverageEvidence.length === 0 ||
    finding.coverageEvidence.some((entry) => entry.trim() === "")
  ) {
    throw new Error(`coverage evidence is missing: ${finding.id}`);
  }
}

function isClassification(value: unknown): value is Phase50ConformanceClassification {
  return typeof value === "string" && PHASE50_CONFORMANCE_CLASSIFICATIONS.some((entry) => entry === value);
}

function isCoverageRoute(value: unknown): value is Phase50CoverageRoute {
  return typeof value === "string" && PHASE50_COVERAGE_ROUTES.some((entry) => entry === value);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => text(entry, `${label}[${index}]`));
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be boolean`);
  }
  return value;
}
