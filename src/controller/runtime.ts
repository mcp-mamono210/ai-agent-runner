import type { ControllerConfig } from "./config.js";
import {
  AbortableSleeper,
  AgentController,
  type ControllerDependencies,
} from "./controller.js";
import { InMemoryIssueLock } from "./local-lock.js";

export type ControllerPorts = Omit<
  ControllerDependencies,
  "localLock" | "sleeper"
>;

/**
 * Phase 48-1 composition root.
 *
 * The local-lock decision is intentionally concrete here: v0.4.0 uses one
 * Controller process / one Worker / concurrency=1, so process-local memory is
 * enough. A future topology change must revisit this decision explicitly.
 */
export function createAgentController(
  config: ControllerConfig,
  ports: ControllerPorts,
): AgentController {
  return new AgentController(config, {
    ...ports,
    localLock: new InMemoryIssueLock(),
    sleeper: new AbortableSleeper(),
  });
}

export async function startAgentController(input: {
  readonly config: ControllerConfig;
  readonly ports: ControllerPorts;
  readonly signal: AbortSignal;
}): Promise<void> {
  const controller = createAgentController(input.config, input.ports);
  await controller.run(input.signal);
}
