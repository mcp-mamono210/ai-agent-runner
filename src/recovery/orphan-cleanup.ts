import { lstat, realpath, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { DockerCommandRunner } from "../sandbox/docker-runtime.js";
import type { OrphanCleanupSummary, OrphanRuntimeCleaner } from "./types.js";

const SANDBOX_ROLE_LABEL = "io.mcp.agent-runner.sandbox=true";
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/u;
const WORKSPACE_NAME_PATTERN =
  /^attempt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[A-Za-z0-9]+$/u;

export class DockerWorkspaceOrphanCleaner implements OrphanRuntimeCleaner {
  readonly #docker: DockerCommandRunner;
  readonly #workspaceRoot: string;

  constructor(input: {
    readonly docker: DockerCommandRunner;
    readonly workspaceRoot: string;
  }) {
    if (!isAbsolute(input.workspaceRoot)) {
      throw new Error("recovery workspace root must be absolute");
    }
    const root = resolve(input.workspaceRoot);
    if (root === "/") {
      throw new Error("recovery workspace root must not be host root");
    }
    this.#docker = input.docker;
    this.#workspaceRoot = root;
  }

  async cleanup(): Promise<OrphanCleanupSummary> {
    const removedSandboxContainers = await this.#removeOwnedSandboxContainers();
    const removedWorkspaces = await this.#removeOwnedWorkspaces();
    return Object.freeze({ removedSandboxContainers, removedWorkspaces });
  }

  async #removeOwnedSandboxContainers(): Promise<number> {
    const output = await this.#docker.run([
      "ps",
      "-aq",
      "--filter",
      `label=${SANDBOX_ROLE_LABEL}`,
    ]);
    const containerIds = output
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");

    if (new Set(containerIds).size !== containerIds.length) {
      throw new Error("orphan sandbox enumeration returned duplicate container IDs");
    }
    for (const containerId of containerIds) {
      if (!CONTAINER_ID_PATTERN.test(containerId)) {
        throw new Error("orphan sandbox enumeration returned an invalid container ID");
      }
    }
    for (const containerId of containerIds) {
      await this.#docker.run(["rm", "-f", containerId]);
    }
    return containerIds.length;
  }

  async #removeOwnedWorkspaces(): Promise<number> {
    let metadata;
    try {
      metadata = await lstat(this.#workspaceRoot);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return 0;
      }
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("configured workspace root must be a real directory during recovery");
    }

    const canonicalRoot = await realpath(this.#workspaceRoot);
    if (canonicalRoot === "/") {
      throw new Error("canonical recovery workspace root must not be host root");
    }

    const entries = await readdir(canonicalRoot, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!WORKSPACE_NAME_PATTERN.test(entry.name)) {
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("owned-looking recovery workspace is not a real directory");
      }
      const path = join(canonicalRoot, entry.name);
      assertDescendant(canonicalRoot, path);
      await rm(path, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}

function assertDescendant(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("recovery workspace escaped configured workspace root");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
