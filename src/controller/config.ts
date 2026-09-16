export const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface ControllerConfig {
  readonly allowedProjectIds: readonly number[];
  readonly pollIntervalMs: number;
}

export function loadControllerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ControllerConfig {
  return {
    allowedProjectIds: parseAllowedProjectIds(env.AGENT_RUNNER_ALLOWED_PROJECTS),
    pollIntervalMs: parsePollIntervalMs(env.AGENT_RUNNER_POLL_INTERVAL_MS),
  };
}

export function parseAllowedProjectIds(raw: string | undefined): readonly number[] {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("AGENT_RUNNER_ALLOWED_PROJECTS is required");
  }

  const ids = raw.split(",").map((part) => {
    const value = Number(part.trim());
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        "AGENT_RUNNER_ALLOWED_PROJECTS must contain positive integer project IDs",
      );
    }
    return value;
  });

  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length !== ids.length) {
    throw new Error("AGENT_RUNNER_ALLOWED_PROJECTS must not contain duplicates");
  }

  return Object.freeze(uniqueIds);
}

export function parsePollIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("AGENT_RUNNER_POLL_INTERVAL_MS must be a positive integer");
  }
  return value;
}
