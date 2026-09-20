import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

import {
  Phase48_5SandboxPreparationFailureHandler,
  Phase48_5SandboxPreparedHandler,
} from "../../src/agent/phase48-5-handler.js";
import type {
  AgentAdapter,
  StartedExecutionFailureFinalizer,
} from "../../src/agent/types.js";
import { AgentController } from "../../src/controller/controller.js";
import type { LocalIssueLock } from "../../src/controller/local-lock.js";
import type { ValidatedHandoff } from "../../src/controller/types.js";
import { GitDevelopmentChangeSetCollector } from "../../src/development/change-set.js";
import {
  InMemoryDevelopmentPhase49HandoffStore,
  Phase48_7ProvisionalResultHandler,
} from "../../src/development/phase49-handoff.js";
import { Phase48DevelopmentWalkingSkeleton } from "../../src/development/walking-skeleton.js";
import { Phase48_3ExactSourceResolvedHandler } from "../../src/execution/preparation.js";
import type { PreparedExecution } from "../../src/execution/types.js";
import { Phase48_2EligibleCandidateHandler } from "../../src/repository/phase48-2-handler.js";
import type {
  RepositoryCheckout,
  RepositorySourceResolver,
} from "../../src/repository/types.js";
import { Phase48_4AgentRunningConfirmedHandler } from "../../src/sandbox/phase48-4-handler.js";
import type {
  SandboxHandle,
  SandboxRuntime,
} from "../../src/sandbox/types.js";
import { TaskWorkspaceManager } from "../../src/sandbox/workspace.js";

const EXECUTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const FINGERPRINT = `sha256:${"b".repeat(64)}`;
const REPOSITORY = "mcp-mamono210/example";

void describe("Phase 48-7 integrated development Walking Skeleton", () => {
  void it(
    "runs Ready for Agent through one Agent invocation to a local Phase 49 handoff and then resets the disposable fixture",
    async () => {
      const createdRoot = await mkdtemp(
        join(tmpdir(), "phase48-7-walking-"),
      );

      // macOSでは /var/... が /private/var/... に canonicalize される。
      // TaskWorkspaceManager も内部で realpath() を使用するため、
      // test fixture の基準パスも最初から canonical path に統一する。
      const root = await realpath(createdRoot);

      const baseline = join(root, "baseline");
      const workspaceRoot = join(root, "workspaces");
      const order: string[] = [];
      const failureFinalizations: string[] = [];

      let workspacePath = "";
      let agentInvocations = 0;
      let startedExecution: PreparedExecution | undefined;

      try {
        await initializeBaseline(baseline);

        const sourceRevision = (
          await runGit(baseline, ["rev-parse", "HEAD"])
        ).trim();

        const handoff: ValidatedHandoff = {
          issueId: 5416,
          repository: REPOSITORY,
          approvedRequirementsFingerprint: FINGERPRINT,
          approval: {
            approverIdentity: "redmine-user:3",
            approvedAt: "2026-09-21T00:00:00Z",
            briefRevision: 7,
            persistedRevision: "persisted-revision",
          },
          opaque: {},
        };

        const store = new InMemoryDevelopmentPhase49HandoffStore();

        const gitCollector = new GitDevelopmentChangeSetCollector({
          patchCaptureBytes: 64 * 1024,
        });

        const provisionalHandler =
          new Phase48_7ProvisionalResultHandler({
            collector: {
              collect: async (path) => {
                order.push("phase49-handoff");
                return await gitCollector.collect(path);
              },
            },
            sink: store,
            summaryCaptureBytes: 4096,
          });

        /*
         * この成功シナリオでは failure finalization は呼ばれてはならない。
         *
         * 以前はここで即座に
         *
         *   unexpected failure finalization
         *
         * を throw していたため、Phase 48-4 が捕捉した本来の
         * checkout / workspace / sandbox preparation error が隠れていた。
         *
         * resolve させて記録だけ行うことで、Phase48_4 handler 自身が
         * original error を rethrow できるようにする。
         */
        const failureFinalizer: StartedExecutionFailureFinalizer = {
          finalizeFailure: (input) => {
            failureFinalizations.push(input.outcome);
            return Promise.resolve();
          },
        };

        const agentAdapter: AgentAdapter = {
          runAgent: async (input) => {
            order.push("agent");
            agentInvocations += 1;

            assert.equal(
              input.executionInput.executionId,
              EXECUTION_ID,
            );

            await appendFile(
              join(input.workspace.path, "tracked.txt"),
              "agent-change\n",
              "utf8",
            );

            return {
              kind: "provisional_success",
              outcome: "changes_ready",
              output: {
                text: "implemented",
                capturedBytes: 11,
                truncated: false,
              },
              diagnostic: {
                text: "",
                capturedBytes: 0,
                truncated: false,
              },
            };
          },
        };

        const phase48_5 = new Phase48_5SandboxPreparedHandler({
          agentAdapter,
          failureFinalizer,
          provisionalResultHandler: provisionalHandler,
        });

        const repositoryCheckout: RepositoryCheckout = {
          checkout: async (input) => {
            order.push("checkout");
            workspacePath = input.targetDir;

            /*
             * workspaceRoot と targetDir の双方を canonical path 基準で
             * 比較する。root 自体を realpath 済みなので通常は同一表現に
             * なるが、boundary assertion として realpath を維持する。
             */
            const canonicalWorkspaceRoot =
              await realpath(workspaceRoot);

            assert.equal(
              relative(
                canonicalWorkspaceRoot,
                input.targetDir,
              ).startsWith(".."),
              false,
            );

            await runGit(root, [
              "clone",
              "-q",
              "--no-hardlinks",
              baseline,
              input.targetDir,
            ]);

            const headRevision = (
              await runGit(input.targetDir, [
                "rev-parse",
                "HEAD",
              ])
            ).trim();

            return {
              repository: input.repository,
              sourceRevision: input.sourceRevision,
              targetDir: input.targetDir,
              headRevision,
            };
          },
        };

        const sandboxRuntime: SandboxRuntime = {
          create: ({ execution, workspace }) => {
            order.push("sandbox");

            const signal = new AbortController().signal;

            const handle: SandboxHandle = {
              containerId: "development-sandbox",
              executionId: execution.input.executionId,
              workspace,
              resources: {
                executionTimeoutMs: 60_000,
                outputCaptureBytes: 65_536,
                diagnosticCaptureBytes: 65_536,
                workspaceDiskBytes: 8 * 1024 * 1024,
                containerLifecycleMs: 90_000,
                workspaceCheckIntervalMs: 1000,
                tmpfsBytes: 1024 * 1024,
              },
              enforcementSignal: signal,

              inspectIsolation: () =>
                Promise.resolve({
                  containerId: "development-sandbox",
                  workspaceSource: workspace.path,
                  workspaceDestination: "/workspace",
                  networkName: "development-internal",
                  policyDigest: "development-policy",
                }),

              dispose: async (reason) => {
                order.push(
                  `sandbox-dispose:${reason}`,
                );

                await workspace.dispose();
              },
            };

            return Promise.resolve(handle);
          },
        };

        const phase48_4 =
          new Phase48_4AgentRunningConfirmedHandler({
            workspaceManager:
              new TaskWorkspaceManager({
                root: workspaceRoot,
                diskLimitBytes: 8 * 1024 * 1024,
              }),

            repository: repositoryCheckout,
            sandboxRuntime,
            next: phase48_5,

            preAgentFailureHandler:
              new Phase48_5SandboxPreparationFailureHandler(
                failureFinalizer,
              ),
          });

        const phase48_3 =
          new Phase48_3ExactSourceResolvedHandler({
            formalGate: {
              authorize: (input) => {
                order.push("formal-gate");

                assert.equal(
                  input.repository,
                  REPOSITORY,
                );

                assert.equal(
                  input.sourceRevision,
                  sourceRevision,
                );

                return Promise.resolve();
              },
            },

            rejectionWriter: {
              reject: () =>
                Promise.reject(
                  new Error(
                    "unexpected rejection",
                  ),
                ),
            },

            executionIdAllocator: {
              allocate: () => {
                order.push("execution-id");
                return EXECUTION_ID;
              },
            },

            agentRunningWriter: {
              persistAndConfirm: (execution) => {
                order.push(
                  "agent-running-confirmed",
                );

                startedExecution = execution;

                return Promise.resolve();
              },
            },

            next: phase48_4,

            clock: () =>
              new Date(
                "2026-09-21T00:00:01Z",
              ),
          });

        const repositorySource:
          RepositorySourceResolver = {
            resolveExactSource: (repository) => {
              order.push(
                "early-authorized-source-resolution",
              );

              assert.equal(
                repository,
                REPOSITORY,
              );

              return Promise.resolve({
                repository,
                sourceRevision,
              });
            },
          };

        const phase48_2 =
          new Phase48_2EligibleCandidateHandler({
            repository: repositorySource,

            rejectionWriter: {
              reject: () =>
                Promise.reject(
                  new Error(
                    "unexpected rejection",
                  ),
                ),
            },

            next: phase48_3,
          });

        const localLock =
          new RecordingLock(order);

        const controller = new AgentController(
          {
            allowedProjectIds: [414],
            pollIntervalMs: 30_000,
          },
          {
            candidateSource: {
              listReadyForAgentCandidates: () => {
                order.push("candidate");

                return Promise.resolve([
                  {
                    issueId: 5416,
                    projectId: 414,
                  },
                ]);
              },
            },

            issueReader: {
              getIssue: () => {
                order.push("refetch");

                return Promise.resolve({
                  issueId: 5416,
                  projectId: 414,
                  lifecycle:
                    "Ready for Agent",
                  raw: {},
                });
              },
            },

            handoffValidator: {
              validate: () => {
                order.push("handoff");

                return Promise.resolve({
                  ok: true,
                  handoff,
                } as const);
              },
            },

            requirementsRevalidator: {
              revalidate: () => {
                order.push("requirements");

                return Promise.resolve({
                  kind: "current",
                  currentFingerprint:
                    FINGERPRINT,
                } as const);
              },
            },

            rejectionWriter: {
              reject: () =>
                Promise.reject(
                  new Error(
                    "unexpected rejection",
                  ),
                ),
            },

            startupReconciler: {
              reconcile: () =>
                Promise.resolve(),
            },

            eligibleCandidateHandler:
              phase48_2,

            localLock,

            sleeper: {
              sleep: () =>
                Promise.resolve(),
            },
          },
        );

        const walkingSkeleton =
          new Phase48DevelopmentWalkingSkeleton({
            controller,
            handoffStore: store,

            fixtureReset: {
              reset: () => {
                order.push(
                  "fixture-reset",
                );

                return Promise.resolve();
              },
            },
          });

        const phase49Handoff =
          await walkingSkeleton.runOnce();

        /*
         * Successful Walking Skeleton invariants.
         */
        assert.equal(
          agentInvocations,
          1,
        );

        assert.deepEqual(
          failureFinalizations,
          [],
        );

        assert.equal(
          phase49Handoff.executionId,
          EXECUTION_ID,
        );

        assert.equal(
          phase49Handoff.sourceRevision,
          sourceRevision,
        );

        assert.equal(
          phase49Handoff.provisionalOutcome,
          "changes_ready",
        );

        assert.deepEqual(
          phase49Handoff.changedFiles,
          [
            {
              path: "tracked.txt",
              status: "modified",
            },
          ],
        );

        assert.match(
          phase49Handoff.localChangeSet.patch.text,
          /agent-change/u,
        );

        assert.equal(
          phase49Handoff.localChangeSet.patch.truncated,
          false,
        );

        assert.equal(
          startedExecution?.input.executionId,
          phase49Handoff.executionId,
        );

        assert.equal(
          startedExecution?.input.sourceRevision,
          phase49Handoff.sourceRevision,
        );

        /*
         * Fixed execution ordering required by Phase 48.
         */
        assert.deepEqual(order, [
          "candidate",
          "lock",
          "refetch",
          "handoff",
          "requirements",
          "early-authorized-source-resolution",
          "formal-gate",
          "execution-id",
          "agent-running-confirmed",
          "checkout",
          "sandbox",
          "agent",
          "phase49-handoff",
          "sandbox-dispose:success",
          "unlock",
          "fixture-reset",
        ]);

        /*
         * The task-scoped workspace must have been disposed after
         * the provisional handoff was captured.
         */
        await assert.rejects(
          access(workspacePath),
        );
      } finally {
        await rm(root, {
          recursive: true,
          force: true,
        });
      }
    },
  );
});

class RecordingLock
  implements LocalIssueLock
{
  readonly #order: string[];
  readonly #held =
    new Set<number>();

  constructor(order: string[]) {
    this.#order = order;
  }

  tryAcquire(issueId: number): boolean {
    this.#order.push("lock");

    if (this.#held.has(issueId)) {
      return false;
    }

    this.#held.add(issueId);

    return true;
  }

  release(issueId: number): void {
    this.#order.push("unlock");
    this.#held.delete(issueId);
  }

  isHeld(issueId: number): boolean {
    return this.#held.has(issueId);
  }
}

async function initializeBaseline(
  path: string,
): Promise<void> {
  await runGit(tmpdir(), [
    "init",
    "-q",
    path,
  ]);

  await runGit(path, [
    "config",
    "user.email",
    "phase48@example.test",
  ]);

  await runGit(path, [
    "config",
    "user.name",
    "Phase 48",
  ]);

  await writeFile(
    join(path, "tracked.txt"),
    "base\n",
    "utf8",
  );

  await runGit(path, [
    "add",
    "tracked.txt",
  ]);

  await runGit(path, [
    "commit",
    "-q",
    "-m",
    "base",
  ]);
}

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  return await new Promise<string>(
    (
      resolvePromise,
      rejectPromise,
    ) => {
      execFile(
        "git",
        [...args],
        {
          cwd,
          encoding: "utf8",
        },
        (
          error,
          stdout,
        ) => {
          if (error !== null) {
            rejectPromise(
              new Error(
                error.message,
                {
                  cause: error,
                },
              ),
            );

            return;
          }

          resolvePromise(stdout);
        },
      );
    },
  );
}
