import { spawn } from "node:child_process";
import { isAbsolute, sep } from "node:path";

import { BoundedUtf8Capture, type CaptureSnapshot } from "../sandbox/resource-policy.js";

export type DevelopmentChangedFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "type_changed"
  | "unmerged"
  | "untracked"
  | "other";

export interface DevelopmentChangedFile {
  readonly path: string;
  readonly status: DevelopmentChangedFileStatus;
}

export interface DevelopmentLocalChangeSet {
  readonly changedFiles: readonly DevelopmentChangedFile[];
  readonly patch: CaptureSnapshot;
}

export interface DevelopmentChangeSetCollector {
  collect(workspacePath: string): Promise<DevelopmentLocalChangeSet>;
}

interface GitObservation {
  readonly exitCode: number;
  readonly stdout: CaptureSnapshot;
  readonly stderr: CaptureSnapshot;
}

const DEFAULT_METADATA_CAPTURE_BYTES = 1_048_576;
const DIAGNOSTIC_CAPTURE_BYTES = 65_536;

export class GitDevelopmentChangeSetCollector implements DevelopmentChangeSetCollector {
  readonly #patchCaptureBytes: number;
  readonly #metadataCaptureBytes: number;

  constructor(input: {
    readonly patchCaptureBytes: number;
    readonly metadataCaptureBytes?: number;
  }) {
    assertPositiveSafeInteger(input.patchCaptureBytes, "patchCaptureBytes");
    const metadataCaptureBytes = input.metadataCaptureBytes ?? DEFAULT_METADATA_CAPTURE_BYTES;
    assertPositiveSafeInteger(metadataCaptureBytes, "metadataCaptureBytes");
    this.#patchCaptureBytes = input.patchCaptureBytes;
    this.#metadataCaptureBytes = metadataCaptureBytes;
  }

  async collect(workspacePath: string): Promise<DevelopmentLocalChangeSet> {
    if (!isAbsolute(workspacePath)) {
      throw new Error("development change-set workspace path must be absolute");
    }

    const tracked = await runGit({
      cwd: workspacePath,
      args: ["diff", "--name-status", "-z", "--no-renames", "HEAD", "--"],
      stdoutCaptureBytes: this.#metadataCaptureBytes,
      acceptedExitCodes: [0],
    });
    requireCompleteMetadata(tracked, "tracked changed-file list");

    const untracked = await runGit({
      cwd: workspacePath,
      args: ["ls-files", "--others", "--exclude-standard", "-z"],
      stdoutCaptureBytes: this.#metadataCaptureBytes,
      acceptedExitCodes: [0],
    });
    requireCompleteMetadata(untracked, "untracked changed-file list");

    const changedFiles = mergeChangedFiles(
      parseTrackedNameStatus(tracked.stdout.text),
      parseNulPaths(untracked.stdout.text).map((path) => ({
        path,
        status: "untracked" as const,
      })),
    );

    const patch = new BoundedUtf8Capture(this.#patchCaptureBytes);
    const trackedPatch = await runGit({
      cwd: workspacePath,
      args: ["diff", "--binary", "--no-ext-diff", "--no-renames", "HEAD", "--"],
      stdoutCaptureBytes: this.#patchCaptureBytes,
      acceptedExitCodes: [0],
    });
    appendPatchCapture(patch, trackedPatch.stdout);

    for (const file of changedFiles) {
      if (file.status !== "untracked") {
        continue;
      }
      const untrackedPatch = await runGit({
        cwd: workspacePath,
        args: ["diff", "--no-index", "--binary", "--", "/dev/null", file.path],
        stdoutCaptureBytes: this.#patchCaptureBytes,
        acceptedExitCodes: [0, 1],
      });
      appendPatchCapture(patch, untrackedPatch.stdout);
    }

    return Object.freeze({
      changedFiles: Object.freeze(changedFiles),
      patch: patch.snapshot(),
    });
  }
}

function appendPatchCapture(target: BoundedUtf8Capture, source: CaptureSnapshot): void {
  target.append(source.text);
  if (source.truncated) {
    // The inner git capture hit the same finite boundary. Append one marker
    // byte so the outer capture preserves the observable truncation fact
    // without retaining additional unbounded content.
    target.append("\n");
  }
}

function parseTrackedNameStatus(raw: string): readonly DevelopmentChangedFile[] {
  const tokens = raw.split("\0");
  if (tokens[tokens.length - 1] === "") {
    tokens.pop();
  }
  if (tokens.length % 2 !== 0) {
    throw new Error("git tracked changed-file output is malformed");
  }

  const output: DevelopmentChangedFile[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const code = tokens[index];
    const path = tokens[index + 1];
    if (code === undefined || path === undefined || code === "") {
      throw new Error("git tracked changed-file output is incomplete");
    }
    assertRelativeGitPath(path);
    output.push({ path, status: mapGitStatus(code) });
  }
  return output;
}

function parseNulPaths(raw: string): readonly string[] {
  const paths = raw.split("\0");
  if (paths[paths.length - 1] === "") {
    paths.pop();
  }
  for (const path of paths) {
    assertRelativeGitPath(path);
  }
  return paths;
}

function mergeChangedFiles(
  tracked: readonly DevelopmentChangedFile[],
  untracked: readonly DevelopmentChangedFile[],
): DevelopmentChangedFile[] {
  const byPath = new Map<string, DevelopmentChangedFile>();
  for (const entry of [...tracked, ...untracked]) {
    if (byPath.has(entry.path)) {
      throw new Error(`development changed-file identity is duplicated: ${entry.path}`);
    }
    byPath.set(entry.path, entry);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function mapGitStatus(code: string): DevelopmentChangedFileStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "T":
      return "type_changed";
    case "U":
      return "unmerged";
    default:
      return "other";
  }
}

function assertRelativeGitPath(path: string): void {
  if (
    path === "" ||
    path === "." ||
    path === ".." ||
    isAbsolute(path) ||
    path.startsWith(`..${sep}`)
  ) {
    throw new Error("development changed-file path escaped the task workspace");
  }
}

function requireCompleteMetadata(observation: GitObservation, label: string): void {
  if (observation.stdout.truncated) {
    throw new Error(`${label} exceeded the development metadata capture boundary`);
  }
}

async function runGit(input: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly stdoutCaptureBytes: number;
  readonly acceptedExitCodes: readonly number[];
}): Promise<GitObservation> {
  return await new Promise<GitObservation>((resolvePromise, rejectPromise) => {
    const stdout = new BoundedUtf8Capture(input.stdoutCaptureBytes);
    const stderr = new BoundedUtf8Capture(DIAGNOSTIC_CAPTURE_BYTES);
    const child = spawn("git", [...input.args], {
      cwd: input.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", () => rejectPromise(new Error("development git process could not be started")));
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (!input.acceptedExitCodes.includes(exitCode)) {
        rejectPromise(new Error(`development git operation failed with exit code ${exitCode}`));
        return;
      }
      resolvePromise(Object.freeze({
        exitCode,
        stdout: stdout.snapshot(),
        stderr: stderr.snapshot(),
      }));
    });
  });
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
