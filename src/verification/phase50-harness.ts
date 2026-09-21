import { createHash } from "node:crypto";

import {
  Phase49S3OperationError,
  type Phase49S3GetInput,
  type Phase49S3GetObservation,
  type Phase49S3HeadInput,
  type Phase49S3ObjectClient,
  type Phase49S3ObjectObservation,
  type Phase49S3PutInput,
} from "../artifact/s3-persistence.js";

export const PHASE50_FAULT_IDS = [
  "FI-01",
  "FI-02",
  "FI-03",
  "FI-04",
  "FI-05",
  "FI-06",
  "FI-07",
  "FI-08",
  "FI-09",
  "FI-10",
  "FI-11",
  "FI-12",
  "FI-13",
  "FI-14",
  "FI-15",
] as const;

export type Phase50FaultId = (typeof PHASE50_FAULT_IDS)[number];

export const PHASE50_SCENARIO_IDS = [
  "SC-01",
  "SC-02",
  "SC-03",
  "SC-04",
  "SC-05",
  "SC-06",
  "SC-07",
] as const;

export type Phase50ScenarioId = (typeof PHASE50_SCENARIO_IDS)[number];

export type Phase50FaultTiming = "before" | "after" | "checkpoint" | "before-or-after";

export interface Phase50FaultDefinition {
  readonly id: Phase50FaultId;
  readonly timing: Phase50FaultTiming;
  readonly consumerTickets: readonly string[];
  readonly description: string;
}

export const PHASE50_FAULT_DEFINITIONS: Readonly<Record<Phase50FaultId, Phase50FaultDefinition>> =
  Object.freeze({
    "FI-01": definition("FI-01", "before", ["50-5"], "Agent Running mutation definite failure"),
    "FI-02": definition(
      "FI-02",
      "after",
      ["50-5"],
      "Agent Running mutation remote success followed by exact read-back failure or timeout",
    ),
    "FI-03": definition("FI-03", "before", ["50-4"], "Agent start failure"),
    "FI-04": definition("FI-04", "after", ["50-4"], "Agent execution failure"),
    "FI-05": definition("FI-05", "after", ["50-4"], "execution timeout"),
    "FI-06": definition(
      "FI-06",
      "checkpoint",
      ["50-6"],
      "Controller interruption after Agent result and before artifact persistence",
    ),
    "FI-07": definition("FI-07", "before", ["50-4"], "PutObject definite failure"),
    "FI-08": definition(
      "FI-08",
      "after",
      ["50-6"],
      "PutObject remote success followed by client timeout or ambiguous result",
    ),
    "FI-09": definition(
      "FI-09",
      "checkpoint",
      ["50-6"],
      "Controller interruption after artifact persistence and before successful Redmine finalization",
    ),
    "FI-10": definition(
      "FI-10",
      "before-or-after",
      ["50-5"],
      "successful Redmine finalization definite failure or ambiguity",
    ),
    "FI-11": definition(
      "FI-11",
      "before-or-after",
      ["50-5"],
      "started-failure finalization definite failure or ambiguity",
    ),
    "FI-12": definition("FI-12", "before", ["50-6", "50-7"], "HeadObject failure"),
    "FI-13": definition("FI-13", "before", ["50-6", "50-7"], "GetObject failure"),
    "FI-14": definition(
      "FI-14",
      "before",
      ["50-3"],
      "formal authorization gate invocation failure",
    ),
    "FI-15": definition(
      "FI-15",
      "before",
      ["50-7"],
      "sandbox network-policy application failure",
    ),
  });

export const PHASE50_SCENARIO_CONSUMERS: Readonly<Record<Phase50ScenarioId, readonly string[]>> =
  Object.freeze({
    "SC-01": Object.freeze(["50-3"]),
    "SC-02": Object.freeze(["50-7"]),
    "SC-03": Object.freeze(["50-7"]),
    "SC-04": Object.freeze(["50-3", "50-6"]),
    "SC-05": Object.freeze(["50-3", "50-6"]),
    "SC-06": Object.freeze(["50-3", "50-6"]),
    "SC-07": Object.freeze(["50-6", "50-7"]),
  });

export interface Phase50ScenarioValueMap {
  readonly "SC-01": "allow" | "deny" | "unknown" | "invalid";
  readonly "SC-02": number;
  readonly "SC-03": number;
  readonly "SC-04": string;
  readonly "SC-05": number;
  readonly "SC-06": string;
  readonly "SC-07":
    | "none"
    | "missing-checksum"
    | "checksum-mismatch"
    | "metadata-missing"
    | "metadata-mismatch"
    | "body-corrupt";
}

export class Phase50InjectedFaultError extends Error {
  readonly faultId: Phase50FaultId;

  constructor(faultId: Phase50FaultId, message?: string) {
    super(message ?? `Phase 50 injected fault ${faultId}`);
    this.name = "Phase50InjectedFaultError";
    this.faultId = faultId;
  }
}

interface ArmedFault {
  readonly error: Error;
  readonly timing: "before" | "after" | "checkpoint";
}

export class Phase50FaultController {
  readonly #armed = new Map<Phase50FaultId, ArmedFault>();
  readonly #observed: Phase50FaultId[] = [];

  arm(
    id: Phase50FaultId,
    input: { readonly error?: Error; readonly timing?: "before" | "after" } = {},
  ): void {
    if (this.#armed.has(id)) {
      throw new Error(`Phase 50 fault is already armed: ${id}`);
    }
    const definitionValue = PHASE50_FAULT_DEFINITIONS[id];
    let timing: ArmedFault["timing"];
    if (definitionValue.timing === "checkpoint") {
      if (input.timing !== undefined) {
        throw new Error(`Phase 50 checkpoint fault ${id} cannot override timing`);
      }
      timing = "checkpoint";
    } else if (definitionValue.timing === "before-or-after") {
      timing = input.timing ?? "before";
    } else {
      if (input.timing !== undefined && input.timing !== definitionValue.timing) {
        throw new Error(`Phase 50 fault ${id} has fixed ${definitionValue.timing} timing`);
      }
      timing = definitionValue.timing;
    }
    this.#armed.set(id, Object.freeze({
      error: input.error ?? new Phase50InjectedFaultError(id),
      timing,
    }));
  }

  isArmed(id: Phase50FaultId): boolean {
    return this.#armed.has(id);
  }

  observed(): readonly Phase50FaultId[] {
    return Object.freeze([...this.#observed]);
  }

  checkpoint(id: Phase50FaultId): void {
    const armed = this.#armed.get(id);
    if (PHASE50_FAULT_DEFINITIONS[id].timing !== "checkpoint") {
      throw new Error(`Phase 50 fault ${id} is not a checkpoint fault`);
    }
    if (armed !== undefined && armed.timing !== "checkpoint") {
      throw new Error(`Phase 50 fault ${id} has invalid armed timing`);
    }
    this.#throwIfArmed(id);
  }

  async around<T>(id: Phase50FaultId, operation: () => T | Promise<T>): Promise<T> {
    const definitionValue = PHASE50_FAULT_DEFINITIONS[id];
    if (definitionValue.timing === "checkpoint") {
      throw new Error(`Phase 50 checkpoint fault ${id} cannot wrap an operation`);
    }
    const armed = this.#armed.get(id);
    const timing = armed?.timing ?? (definitionValue.timing === "before-or-after" ? "before" : definitionValue.timing);
    if (timing === "before") {
      this.#throwIfArmed(id);
      return await operation();
    }
    const result = await operation();
    this.#throwIfArmed(id);
    return result;
  }

  reset(): void {
    this.#armed.clear();
    this.#observed.length = 0;
  }

  #throwIfArmed(id: Phase50FaultId): void {
    const armed = this.#armed.get(id);
    if (armed === undefined) {
      return;
    }
    this.#armed.delete(id);
    this.#observed.push(id);
    throw armed.error;
  }
}

export class Phase50ScenarioController {
  readonly #values = new Map<Phase50ScenarioId, Phase50ScenarioValueMap[Phase50ScenarioId]>();

  set<K extends Phase50ScenarioId>(id: K, value: Phase50ScenarioValueMap[K]): void {
    this.#values.set(id, value);
  }

  get<K extends Phase50ScenarioId>(id: K): Phase50ScenarioValueMap[K] | undefined {
    return this.#values.get(id) as Phase50ScenarioValueMap[K] | undefined;
  }

  require<K extends Phase50ScenarioId>(id: K): Phase50ScenarioValueMap[K] {
    const value = this.get(id);
    if (value === undefined) {
      throw new Error(`Phase 50 scenario is not configured: ${id}`);
    }
    return value;
  }

  reset(): void {
    this.#values.clear();
  }
}

export interface Phase50RedmineFixtureState {
  readonly lifecycle: string;
  readonly outcome: string;
  readonly requirementsFingerprint: string;
}

export class Phase50RedmineFixture {
  #state: Phase50RedmineFixtureState;
  readonly #initial: Phase50RedmineFixtureState;
  readonly #faults: Phase50FaultController;

  constructor(faults: Phase50FaultController, initial?: Partial<Phase50RedmineFixtureState>) {
    this.#faults = faults;
    this.#initial = Object.freeze({
      lifecycle: initial?.lifecycle ?? "Ready for Agent",
      outcome: initial?.outcome ?? "",
      requirementsFingerprint: initial?.requirementsFingerprint ?? `sha256:${"a".repeat(64)}`,
    });
    this.#state = this.#initial;
  }

  snapshot(): Phase50RedmineFixtureState {
    return this.#state;
  }

  async writeAgentRunning(): Promise<void> {
    await this.#faults.around("FI-01", () => {
      this.#state = Object.freeze({ ...this.#state, lifecycle: "Agent Running" });
    });
    await this.#faults.around("FI-02", () => undefined);
  }

  async writeSuccessfulFinalization(outcome: "changes_ready" | "no_changes"): Promise<void> {
    await this.#faults.around("FI-10", () => {
      this.#state = Object.freeze({
        ...this.#state,
        lifecycle: "Ready for Independent Verification",
        outcome,
      });
    });
  }

  async writeFailureFinalization(outcome: string): Promise<void> {
    await this.#faults.around("FI-11", () => {
      this.#state = Object.freeze({ ...this.#state, lifecycle: "Needs Human", outcome });
    });
  }

  reset(): void {
    this.#state = this.#initial;
  }

  applyMutableScenarios(scenarios: Phase50ScenarioController): void {
    const requirements = scenarios.get("SC-04");
    this.#state = Object.freeze({
      ...this.#state,
      ...(requirements === undefined ? {} : { requirementsFingerprint: requirements }),
    });
  }
}

export class Phase50BriefFixture {
  #currentRevision = 1;

  currentRevision(): number {
    return this.#currentRevision;
  }

  applyMutableScenarios(scenarios: Phase50ScenarioController): void {
    const revision = scenarios.get("SC-05");
    if (revision !== undefined) {
      this.#currentRevision = revision;
    }
  }

  reset(): void {
    this.#currentRevision = 1;
  }
}

export class Phase50GitFixture {
  #branchHead = "b".repeat(40);

  branchHead(): string {
    return this.#branchHead;
  }

  applyMutableScenarios(scenarios: Phase50ScenarioController): void {
    const head = scenarios.get("SC-06");
    if (head !== undefined) {
      this.#branchHead = head;
    }
  }

  reset(): void {
    this.#branchHead = "b".repeat(40);
  }
}

export class Phase50DeterministicAgentFixture {
  readonly #faults: Phase50FaultController;
  readonly #scenarios: Phase50ScenarioController;

  constructor(faults: Phase50FaultController, scenarios: Phase50ScenarioController) {
    this.#faults = faults;
    this.#scenarios = scenarios;
  }

  async start(): Promise<void> {
    await this.#faults.around("FI-03", () => undefined);
  }

  async run(outcome: "changes_ready" | "no_changes"): Promise<{
    readonly outcome: "changes_ready" | "no_changes";
    readonly output: string;
  }> {
    await this.#faults.around("FI-04", () => undefined);
    await this.#faults.around("FI-05", () => undefined);
    const bytes = this.#scenarios.get("SC-02") ?? 0;
    return Object.freeze({ outcome, output: "x".repeat(bytes) });
  }
}

export class Phase50SandboxFixture {
  readonly #faults: Phase50FaultController;
  readonly #scenarios: Phase50ScenarioController;
  #networkPolicyApplied = false;

  constructor(faults: Phase50FaultController, scenarios: Phase50ScenarioController) {
    this.#faults = faults;
    this.#scenarios = scenarios;
  }

  async applyNetworkPolicy(): Promise<void> {
    await this.#faults.around("FI-15", () => {
      this.#networkPolicyApplied = true;
    });
  }

  assertNetworkPolicyApplied(): void {
    if (!this.#networkPolicyApplied) {
      throw new Error("Phase 50 sandbox network policy was not applied");
    }
  }

  workspaceBytes(): number {
    return this.#scenarios.get("SC-03") ?? 0;
  }

  reset(): void {
    this.#networkPolicyApplied = false;
  }
}

interface StoredObject {
  readonly body: Uint8Array;
  readonly checksumSha256Base64: string;
  readonly metadata: Readonly<Record<string, string | undefined>>;
  readonly serverSideEncryption: string;
}

export class Phase50InMemoryS3ObjectClient implements Phase49S3ObjectClient {
  readonly #faults: Phase50FaultController;
  readonly #scenarios: Phase50ScenarioController;
  readonly #objects = new Map<string, StoredObject>();

  constructor(faults: Phase50FaultController, scenarios: Phase50ScenarioController) {
    this.#faults = faults;
    this.#scenarios = scenarios;
  }

  async putObject(input: Phase49S3PutInput): Promise<void> {
    const id: Phase50FaultId = this.#faults.isArmed("FI-08") ? "FI-08" : "FI-07";
    await this.#faults.around(id, () => {
      const address = addressOf(input.bucket, input.key);
      if (this.#objects.has(address)) {
        throw new Phase49S3OperationError("conflict", "Phase 50 fixture existing object");
      }
      this.#objects.set(
        address,
        Object.freeze({
          body: Uint8Array.from(input.body),
          checksumSha256Base64: input.checksumSha256Base64,
          metadata: Object.freeze({ ...input.metadata }),
          serverSideEncryption: input.serverSideEncryption,
        }),
      );
    });
  }

  async headObject(input: Phase49S3HeadInput): Promise<Phase49S3ObjectObservation> {
    return await this.#faults.around("FI-12", () => {
      const stored = this.#requiredObject(input.bucket, input.key);
      return this.#observation(stored);
    });
  }

  async getObject(input: Phase49S3GetInput): Promise<Phase49S3GetObservation> {
    return await this.#faults.around("FI-13", () => {
      const stored = this.#requiredObject(input.bucket, input.key);
      const observation = this.#observation(stored);
      return Object.freeze({ ...observation, body: this.#corruptedBody(stored.body) });
    });
  }

  hasObject(bucket: string, key: string): boolean {
    return this.#objects.has(addressOf(bucket, key));
  }

  reset(): void {
    this.#objects.clear();
  }

  #requiredObject(bucket: string, key: string): StoredObject {
    const stored = this.#objects.get(addressOf(bucket, key));
    if (stored === undefined) {
      throw new Phase49S3OperationError("not_found", "Phase 50 fixture object is absent");
    }
    return stored;
  }

  #observation(stored: StoredObject): Phase49S3ObjectObservation {
    const corruption = this.#scenarios.get("SC-07") ?? "none";
    const checksum = corruption === "missing-checksum"
      ? undefined
      : corruption === "checksum-mismatch"
        ? Buffer.from(createHash("sha256").update("corrupt").digest()).toString("base64")
        : stored.checksumSha256Base64;
    const metadata = corruption === "metadata-missing"
      ? undefined
      : corruption === "metadata-mismatch"
        ? Object.freeze({ ...stored.metadata, repository: "corrupt/repository" })
        : stored.metadata;
    return Object.freeze({
      checksumType: "FULL_OBJECT",
      checksumSha256Base64: checksum,
      metadata,
      serverSideEncryption: stored.serverSideEncryption,
      contentLength: stored.body.byteLength,
    });
  }

  #corruptedBody(body: Uint8Array): Uint8Array {
    if (this.#scenarios.get("SC-07") !== "body-corrupt") {
      return Uint8Array.from(body);
    }
    const copy = Uint8Array.from(body);
    if (copy.length === 0) {
      return Uint8Array.of(1);
    }
    const first = copy[0];
    if (first === undefined) {
      return Uint8Array.of(1);
    }
    copy[0] = first === 0 ? 1 : first ^ 1;
    return copy;
  }
}

export class Phase50DeterministicHarness {
  readonly faults = new Phase50FaultController();
  readonly scenarios = new Phase50ScenarioController();
  readonly redmine = new Phase50RedmineFixture(this.faults);
  readonly brief = new Phase50BriefFixture();
  readonly git = new Phase50GitFixture();
  readonly agent = new Phase50DeterministicAgentFixture(this.faults, this.scenarios);
  readonly sandbox = new Phase50SandboxFixture(this.faults, this.scenarios);
  readonly s3 = new Phase50InMemoryS3ObjectClient(this.faults, this.scenarios);

  checkpointAfterAgentResult(): void {
    this.faults.checkpoint("FI-06");
  }

  checkpointAfterArtifactPersistence(): void {
    this.faults.checkpoint("FI-09");
  }

  applyMutableScenarios(): void {
    this.redmine.applyMutableScenarios(this.scenarios);
    this.brief.applyMutableScenarios(this.scenarios);
    this.git.applyMutableScenarios(this.scenarios);
  }

  async formalAuthorizationGate(): Promise<void> {
    await this.faults.around("FI-14", () => {
      const state = this.scenarios.get("SC-01") ?? "allow";
      if (state !== "allow") {
        throw new Error(`Phase 50 authorization fixture rejected: ${state}`);
      }
    });
  }

  reset(): void {
    this.faults.reset();
    this.scenarios.reset();
    this.redmine.reset();
    this.brief.reset();
    this.git.reset();
    this.sandbox.reset();
    this.s3.reset();
  }
}

function definition(
  id: Phase50FaultId,
  timing: Phase50FaultTiming,
  consumerTickets: readonly string[],
  description: string,
): Phase50FaultDefinition {
  return Object.freeze({ id, timing, consumerTickets: Object.freeze([...consumerTickets]), description });
}

function addressOf(bucket: string, key: string): string {
  return `${bucket}/${key}`;
}
