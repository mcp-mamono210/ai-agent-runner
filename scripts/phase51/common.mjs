import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPOSITORY = "mcp-mamono210/ai-agent-runner";
export const SYSTEM_MILESTONE_VERSION = "0.4.0";
export const SHA1 = /^[0-9a-f]{40}$/u;

export function scriptRoot(importMetaUrl) {
  return resolve(dirname(fileURLToPath(importMetaUrl)), "../..");
}

export function fail(message) {
  throw new Error(message);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function git(root, args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], {
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function requireRevision(root, revision) {
  if (!SHA1.test(revision)) {
    fail(`expected exact 40-hex Git revision, got ${revision}`);
  }
  git(root, ["cat-file", "-e", `${revision}^{commit}`]);
  return revision;
}

export function assertRevisionIsAncestor(root, revision, descendant = "HEAD") {
  try {
    execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", revision, descendant], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    fail(`${revision} is not an ancestor of ${descendant}`);
  }
}

export function gitBlobSha(root, revision, path) {
  const exactRevision = git(root, ["rev-parse", `${revision}^{commit}`]);
  requireRevision(root, exactRevision);
  const sha = git(root, ["rev-parse", `${exactRevision}:${path}`]);
  if (!SHA1.test(sha)) {
    fail(`Git did not return a blob SHA for ${path} at ${exactRevision}`);
  }
  return sha;
}

export function parseCli(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      fail(`unexpected argument: ${arg}`);
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values.set(arg.slice(2), true);
      continue;
    }
    values.set(arg.slice(2), next);
    index += 1;
  }
  return values;
}

export function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    fail(`--${name} is required`);
  }
  return value;
}

export async function importBuilt(root, relativePath) {
  const url = pathToFileURL(resolve(root, relativePath)).href;
  return import(url);
}

export function writeJsonStdout(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
