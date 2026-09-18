import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { TaskWorkspace } from "./types.js";

const EXECUTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class TaskWorkspaceManager {
  readonly #root: string;
  readonly #diskLimitBytes: number;

  constructor(input: { readonly root: string; readonly diskLimitBytes: number }) {
    if (!isAbsolute(input.root)) {
      throw new Error("workspace root must be absolute");
    }
    const root = resolve(input.root);
    if (root === "/") {
      throw new Error("workspace root must not be host root");
    }
    if (!Number.isSafeInteger(input.diskLimitBytes) || input.diskLimitBytes <= 0) {
      throw new Error("workspace disk limit must be a positive safe integer");
    }
    this.#root = root;
    this.#diskLimitBytes = input.diskLimitBytes;
  }

  async create(executionId: string): Promise<TaskWorkspace> {
    if (!EXECUTION_ID_PATTERN.test(executionId)) {
      throw new Error("workspace execution_id must be a canonical lowercase UUIDv4");
    }
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(this.#root);
    const created = await mkdtemp(join(canonicalRoot, `attempt-${executionId}-`));
    await chmod(created, 0o700);
    const canonicalCreated = await realpath(created);
    assertDescendant(canonicalRoot, canonicalCreated);
    return new FileSystemTaskWorkspace({
      executionId,
      path: canonicalCreated,
      diskLimitBytes: this.#diskLimitBytes,
    });
  }
}

class FileSystemTaskWorkspace implements TaskWorkspace {
  readonly executionId: string;
  readonly path: string;
  readonly diskLimitBytes: number;
  #disposed = false;

  constructor(input: {
    readonly executionId: string;
    readonly path: string;
    readonly diskLimitBytes: number;
  }) {
    this.executionId = input.executionId;
    this.path = input.path;
    this.diskLimitBytes = input.diskLimitBytes;
  }

  async measureDiskUsageBytes(): Promise<number> {
    if (this.#disposed) {
      throw new Error("workspace has already been disposed");
    }
    return await measureTreeBytes(this.path, new Set<string>());
  }

  async assertWithinDiskLimit(): Promise<void> {
    const bytes = await this.measureDiskUsageBytes();
    if (bytes > this.diskLimitBytes) {
      throw new Error(
        `workspace disk usage exceeded configured limit: ${bytes} > ${this.diskLimitBytes}`,
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    await rm(this.path, { recursive: true, force: true });
  }
}

async function measureTreeBytes(path: string, seen: Set<string>): Promise<number> {
  const metadata = await lstat(path);
  const identity = `${metadata.dev}:${metadata.ino}`;
  if (seen.has(identity)) {
    return 0;
  }
  seen.add(identity);
  if (!metadata.isDirectory()) {
    return metadata.size;
  }
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    total += await measureTreeBytes(join(path, entry.name), seen);
  }
  return total;
}

function assertDescendant(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("task workspace escaped configured workspace root");
  }
}
