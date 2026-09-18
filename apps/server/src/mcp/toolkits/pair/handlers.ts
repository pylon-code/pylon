/**
 * Pair MCP toolkit handlers: one lead thread and one persistent executor thread.
 *
 * A sidecar over existing orchestration: every write is an existing command
 * and every read is an existing projection. Creates and turn starts use
 * deterministic ids so the command receipt store absorbs retries; interrupts
 * use a unique id per call. The executor shares the lead's worktree, so
 * nothing here creates, modifies, or cleans up git worktrees.
 *
 * @module mcp/toolkits/pair/handlers
 */
import {
  CommandId,
  MessageId,
  getServerProviderSupportedRuntimeModes,
  isProviderAvailable,
  type OrchestrationThreadShell,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import type { OrchestrationDispatchError } from "../../../orchestration/Errors.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import { markDelegationObservationConsumed } from "../../../orchestration/delegationObservationConsumed.ts";
import * as ThreadDeletionReactor from "../../../orchestration/Services/ThreadDeletionReactor.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import { PAIR_LEAD_PROTOCOL } from "../../../provider/RuntimeInstructions.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  aggregateFilesChanged,
  isDelegatedThreadId,
  isValidDelegationKey,
  resolveDelegatedModel,
  resolveDelegatedRuntimeMode,
  resolveDelegationTarget,
  selectAssistantMessage,
  truncateText,
} from "../delegation/logic.ts";
import {
  PAIR_DELEGATION_KEY,
  changedProtectedPaths,
  derivePairExecutorState,
  isPairLeadSupported,
  normalizeProtectedPath,
  latestTurnCheckpoints,
  pairAwaitPlan,
  pairAwaitCapSeconds,
  pairExecutorThreadId,
  pairExecutorTitle,
  pairMessageId,
  pairSteerMessageId,
  type ProtectedPathRecord,
} from "./logic.ts";
import {
  PairArchivedError,
  PairDefaultMissingError,
  PairDepthExceededError,
  PairExecutorBusyError,
  PairFailedError,
  PairKeyInvalidError,
  PairLeadNotFoundError,
  PairLeadUnsupportedError,
  PairMessageKeyConsumedError,
  PairModelUnavailableError,
  PairNotActiveError,
  PairProtectedPathInvalidError,
  PairProviderUnavailableError,
  PairRuntimeModeUnsupportedError,
  PairSteerLimitError,
  PairToolkit,
  PairTurnRejectedError,
  type PairAwaitResult,
  type PairHandoffResult,
  type PairStartResult,
  type PairResetResult,
  type PairStopResult,
} from "./tools.ts";

const DEFAULT_RESULT_CHARS = 4_000;
const POLL_INTERVAL_MS = 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Interrupts pass through; any other cause becomes the generic pair failure. */
const orFail = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, PairFailedError, R> =>
  effect.pipe(
    Effect.catchCause((cause): Effect.Effect<never, PairFailedError> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new PairFailedError({ cause })),
    ),
  );

type DispatchRejection = PairMessageKeyConsumedError | PairTurnRejectedError;

/**
 * Maps specific dispatch rejections to pair errors the agent can act on.
 * Everything unmapped becomes the generic failure; interrupts pass through.
 */
const mapDispatch =
  (map: (error: OrchestrationDispatchError) => DispatchRejection | undefined) =>
  <A, R>(
    effect: Effect.Effect<A, OrchestrationDispatchError, R>,
  ): Effect.Effect<A, DispatchRejection | PairFailedError, R> =>
    effect.pipe(
      Effect.catchCause((cause): Effect.Effect<never, DispatchRejection | PairFailedError> => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
        const error = Cause.findErrorOption(cause);
        const mapped = Option.isSome(error) ? map(error.value) : undefined;
        return Effect.fail(mapped ?? new PairFailedError({ cause }));
      }),
    );

const requirePairCapability = McpInvocationContext.requireMcpCapability("pair").pipe(
  Effect.catch(() => McpInvocationContext.requireMcpCapability("delegation")),
);

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const deletionReactor = yield* ThreadDeletionReactor.ThreadDeletionReactor;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;

  // In memory on purpose, lost on restart, and pair_await then reports null
  // rather than guessing.
  const protectedRecords = new Map<ThreadId, ReadonlyArray<ProtectedPathRecord>>();
  const instantReadCounts = new Map<ThreadId, number>();

  // One permit per lead: tool calls may run concurrently, and executor lookups
  // and busy checks are check-then-act.
  const gates = new Map<ThreadId, Semaphore.Semaphore>();
  const withLeadGate =
    (leadId: ThreadId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        let gate = gates.get(leadId);
        if (gate === undefined) {
          gate = Semaphore.makeUnsafe(1);
          gates.set(leadId, gate);
        }
        return gate.withPermits(1)(effect);
      });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const executorIdFor = Effect.fn("PairToolkit.executorIdFor")(function* (leadId: ThreadId) {
    const digest = yield* orFail(
      crypto.digest("SHA-256", new TextEncoder().encode(`${leadId}\n${PAIR_DELEGATION_KEY}`)),
    );
    const hex = bytesToHex(digest);
    return pairExecutorThreadId(leadId, () => hex);
  });

  const resolveWorktreeRoot = (shell: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      if (shell.worktreePath !== null) return shell.worktreePath;
      const projectOpt = yield* snapshots
        .getProjectShellById(shell.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(projectOpt)) {
        return projectOpt.value.workspaceRoot;
      }
      return null;
    });

  const hashFile = (root: string | null, relativePath: string): Effect.Effect<string | null> => {
    if (root === null) return Effect.succeed(null);
    return fileSystem.readFile(`${root}/${relativePath}`).pipe(
      Effect.flatMap((bytes) => crypto.digest("SHA-256", bytes)),
      Effect.map(bytesToHex),
      Effect.orElseSucceed(() => null),
    );
  };

  /** Active first, then archived; None when neither knows the id. */
  const findExecutor = (executorId: ThreadId) =>
    orFail(
      snapshots
        .getThreadShellById(executorId)
        .pipe(
          Effect.filterOrElse(Option.isSome, () =>
            snapshots
              .getArchivedShellSnapshot()
              .pipe(
                Effect.map((snapshot) =>
                  Option.fromNullishOr(snapshot.threads.find((thread) => thread.id === executorId)),
                ),
              ),
          ),
        ),
    );

  const pair_start = (input: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly model?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("delegation");
      if (isDelegatedThreadId(scope.threadId)) {
        return yield* new PairDepthExceededError({ threadId: scope.threadId });
      }
      const providerList = yield* providers.getProviders;
      const leadSnapshot = providerList.find((p) => p.instanceId === scope.providerInstanceId);
      if (leadSnapshot !== undefined && !isPairLeadSupported(leadSnapshot.driver)) {
        return yield* new PairLeadUnsupportedError({
          providerInstanceId: scope.providerInstanceId,
        });
      }
      const executorId = yield* executorIdFor(scope.threadId);

      return yield* withLeadGate(scope.threadId)(
        Effect.gen(function* () {
          const existing = yield* findExecutor(executorId);
          if (Option.isSome(existing)) {
            const shell = existing.value;
            if (shell.archivedAt !== null) {
              return yield* new PairArchivedError();
            }
            const result: PairStartResult = {
              threadId: executorId,
              created: false,
              state: derivePairExecutorState(shell),
              providerInstanceId: shell.modelSelection.instanceId,
              model: shell.modelSelection.model,
              runtimeMode: shell.runtimeMode,
              worktreePath: shell.worktreePath,
              branch: shell.branch,
              protocol: PAIR_LEAD_PROTOCOL,
            };
            return result;
          }

          const leadOpt = yield* orFail(snapshots.getThreadShellById(scope.threadId));
          if (Option.isNone(leadOpt)) {
            return yield* new PairLeadNotFoundError({ threadId: scope.threadId });
          }
          const lead = leadOpt.value;
          const projectOpt = yield* orFail(snapshots.getProjectShellById(lead.projectId));
          if (Option.isNone(projectOpt)) {
            return yield* new PairLeadNotFoundError({ threadId: scope.threadId });
          }
          const project = projectOpt.value;

          const settings = yield* orFail(serverSettings.getSettings);
          const projectSettings = resolveProjectSettings(settings, project.id).settings;
          const target = resolveDelegationTarget({
            defaultSelection: projectSettings.delegationDefaultModelSelection,
            requestedInstanceId: input.providerInstanceId,
            requestedModel: input.model,
          });
          if (!target.ok) {
            return yield* new PairDefaultMissingError();
          }

          const providerList = yield* providers.getProviders;
          const snapshot = providerList.find((p) => p.instanceId === target.instanceId);
          if (
            snapshot === undefined ||
            !snapshot.enabled ||
            !isProviderAvailable(snapshot) ||
            snapshot.auth.status === "unauthenticated"
          ) {
            return yield* new PairProviderUnavailableError({
              providerInstanceId: target.instanceId,
            });
          }

          const model = resolveDelegatedModel(snapshot, target.model);
          if (!model.ok) {
            return yield* new PairModelUnavailableError({
              providerInstanceId: target.instanceId,
              model: target.model ?? null,
            });
          }

          const mode = resolveDelegatedRuntimeMode(
            lead.runtimeMode,
            undefined,
            projectSettings.delegationChildRuntimeMode,
          );
          if (!mode.ok) {
            return yield* new PairFailedError({
              cause: new Error("Runtime mode resolution failed"),
            });
          }
          if (!getServerProviderSupportedRuntimeModes(snapshot).includes(mode.mode)) {
            return yield* new PairRuntimeModeUnsupportedError({
              providerInstanceId: target.instanceId,
              runtimeMode: mode.mode,
            });
          }

          const modelSelection = {
            instanceId: target.instanceId,
            model: model.model,
            ...(target.defaultApplied === "provider-and-model" && target.options !== undefined
              ? { options: target.options }
              : {}),
          };

          yield* engine
            .dispatch({
              type: "thread.create",
              commandId: CommandId.make(`server:mcp-pair-create:${executorId}`),
              threadId: executorId,
              projectId: project.id,
              title: pairExecutorTitle(lead.title),
              modelSelection,
              runtimeMode: mode.mode,
              interactionMode: "default",
              branch: lead.branch,
              worktreePath: lead.worktreePath,
              createdAt: yield* nowIso,
            })
            .pipe(mapDispatch(() => undefined));

          const result: PairStartResult = {
            threadId: executorId,
            created: true,
            state: "idle",
            providerInstanceId: target.instanceId,
            model: model.model,
            runtimeMode: mode.mode,
            worktreePath: lead.worktreePath,
            branch: lead.branch,
            protocol: PAIR_LEAD_PROTOCOL,
          };
          return result;
        }),
      );
    });

  const pair_handoff = (input: {
    readonly messageKey: string;
    readonly text: string;
    readonly protectedPaths?: ReadonlyArray<string> | undefined;
    readonly steer?: boolean | undefined;
  }) =>
    Effect.gen(function* () {
      const scope = yield* requirePairCapability;
      if (!isValidDelegationKey(input.messageKey)) {
        return yield* new PairKeyInvalidError();
      }
      const executorId = yield* executorIdFor(scope.threadId);

      return yield* withLeadGate(scope.threadId)(
        Effect.gen(function* () {
          const existing = yield* findExecutor(executorId);
          if (Option.isNone(existing)) {
            return yield* new PairNotActiveError();
          }
          const shell = existing.value;
          if (shell.archivedAt !== null) {
            return yield* new PairArchivedError();
          }

          const state = derivePairExecutorState(shell);
          let messageId: MessageId;
          let steered: boolean;
          let nextProtectedRecords: ReadonlyArray<ProtectedPathRecord> | null = null;

          if (state === "running") {
            if (input.steer !== true) {
              return yield* new PairExecutorBusyError();
            }
            const activeTurnId = shell.session?.activeTurnId;
            if (activeTurnId === null || activeTurnId === undefined) {
              return yield* new PairExecutorBusyError();
            }
            messageId = pairSteerMessageId(executorId, activeTurnId);
            const alreadyStarted = yield* orFail(
              snapshots.getTurnStartMessage({ threadId: executorId, messageId }),
            );
            if (Option.isSome(alreadyStarted)) {
              return yield* new PairSteerLimitError();
            }
            steered = true;
          } else {
            messageId = pairMessageId(executorId, input.messageKey);
            steered = false;
            const alreadyStarted = yield* orFail(
              snapshots.getTurnStartMessage({ threadId: executorId, messageId }),
            );
            if (Option.isSome(alreadyStarted)) {
              const acceptedResult: PairHandoffResult = {
                threadId: executorId,
                accepted: true,
                messageId,
                steered: false,
              };
              return acceptedResult;
            }

            // A pair turned on from the composer creates the executor before the lead's
            // first turn has set up its worktree, and a lead can move to another branch,
            // so the executor's location is corrected at the moment it is about to be used
            // rather than chased through events.
            const leadOpt = yield* orFail(snapshots.getThreadShellById(scope.threadId));
            if (Option.isNone(leadOpt)) {
              return yield* new PairLeadNotFoundError({ threadId: scope.threadId });
            }
            const lead = leadOpt.value;

            const needsMove =
              shell.branch !== lead.branch || shell.worktreePath !== lead.worktreePath;

            if (input.protectedPaths !== undefined && input.protectedPaths.length > 0) {
              const root = yield* resolveWorktreeRoot(
                needsMove ? { ...shell, worktreePath: lead.worktreePath } : shell,
              );
              const records: ProtectedPathRecord[] = [];
              const seenPaths = new Set<string>();
              for (const entry of input.protectedPaths) {
                const normalized = normalizeProtectedPath(entry);
                if (normalized === null) {
                  return yield* new PairProtectedPathInvalidError({ path: entry });
                }
                if (seenPaths.has(normalized)) {
                  continue;
                }
                seenPaths.add(normalized);
                const hash = yield* hashFile(root, normalized);
                if (hash === null) {
                  return yield* new PairProtectedPathInvalidError({ path: entry });
                }
                records.push({ path: normalized, hash });
              }
              nextProtectedRecords = records;
            }

            if (needsMove) {
              yield* engine
                .dispatch({
                  type: "thread.meta.update",
                  commandId: CommandId.make(
                    `server:mcp-pair-follow:${executorId}:${input.messageKey}`,
                  ),
                  threadId: executorId,
                  branch: lead.branch,
                  worktreePath: lead.worktreePath,
                })
                .pipe(mapDispatch(() => undefined));
            }
          }

          yield* engine
            .dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make(`server:mcp-pair-turn:${executorId}:${input.messageKey}`),
              threadId: executorId,
              message: { messageId, role: "user", text: input.text, attachments: [] },
              modelSelection: shell.modelSelection,
              runtimeMode: shell.runtimeMode,
              interactionMode: "default",
              sourceEpoch: shell.sourceEpoch ?? 0,
              createdAt: yield* nowIso,
            })
            .pipe(
              mapDispatch((error) =>
                error._tag === "OrchestrationCommandPreviouslyRejectedError"
                  ? new PairMessageKeyConsumedError({ messageKey: input.messageKey })
                  : error._tag === "OrchestrationCommandInvariantError"
                    ? new PairTurnRejectedError({ detail: error.detail })
                    : undefined,
              ),
            );

          if (!steered) {
            if (nextProtectedRecords === null) {
              protectedRecords.delete(executorId);
            } else {
              protectedRecords.set(executorId, nextProtectedRecords);
            }
          }

          const result: PairHandoffResult = {
            threadId: executorId,
            accepted: true,
            messageId,
            steered,
          };
          return result;
        }),
      );
    });

  const pair_await = (input: {
    readonly maxSeconds?: number | undefined;
    readonly maxChars?: number | undefined;
  }) =>
    Effect.gen(function* () {
      const scope = yield* requirePairCapability;
      const executorId = yield* executorIdFor(scope.threadId);
      const existing = yield* findExecutor(executorId);
      if (Option.isNone(existing)) {
        return yield* new PairNotActiveError();
      }

      let current = existing.value;
      let state = derivePairExecutorState(current);

      const providerList = yield* providers.getProviders;
      const leadProvider = providerList.find((p) => p.instanceId === scope.providerInstanceId);
      const driver = leadProvider?.driver;
      const cap = pairAwaitCapSeconds(driver);
      const plan = pairAwaitPlan({
        requestedSeconds: input.maxSeconds,
        capSeconds: cap,
        running: state === "running",
        instantReads: instantReadCounts.get(executorId) ?? 0,
      });
      instantReadCounts.set(executorId, plan.instantReads);
      const waitBudget = plan.budgetSeconds;

      const startedAt = yield* Clock.currentTimeMillis;
      const deadline = startedAt + waitBudget * 1_000;
      const elapsedSeconds = (now: number) => Math.round((now - startedAt) / 1_000);

      let now = startedAt;
      let hasPendingApprovals = current.hasPendingApprovals;
      let hasPendingUserInput = current.hasPendingUserInput;

      if (state === "running" && !hasPendingApprovals && !hasPendingUserInput && waitBudget > 0) {
        while (now < deadline) {
          yield* Effect.sleep(Math.min(POLL_INTERVAL_MS, deadline - now));
          const next = yield* findExecutor(executorId);
          now = yield* Clock.currentTimeMillis;
          if (Option.isNone(next)) {
            return yield* new PairNotActiveError();
          }
          current = next.value;
          state = derivePairExecutorState(current);
          hasPendingApprovals = current.hasPendingApprovals;
          hasPendingUserInput = current.hasPendingUserInput;
          if (state !== "running" || hasPendingApprovals || hasPendingUserInput) {
            break;
          }
        }
      }

      const waitedSeconds = elapsedSeconds(now);

      let assistantMessage: PairAwaitResult["assistantMessage"] = null;
      let filesChanged: PairAwaitResult["filesChanged"] = [];
      let turnCount = 0;
      let protectedPaths: PairAwaitResult["protectedPaths"] = null;

      if (state !== "running" && state !== "archived") {
        const detailOpt = yield* orFail(snapshots.getThreadDetailById(executorId));
        if (Option.isSome(detailOpt)) {
          const detail = detailOpt.value;
          const message = selectAssistantMessage(detail);
          if (message !== null) {
            const body = truncateText(message.text, input.maxChars ?? DEFAULT_RESULT_CHARS);
            assistantMessage = {
              messageId: message.id,
              text: body.text,
              truncated: body.truncated,
              createdAt: message.createdAt,
            };
          }
          filesChanged = aggregateFilesChanged(
            latestTurnCheckpoints(detail.checkpoints, current.latestTurn?.turnId ?? null),
          );
          turnCount = detail.checkpoints.length;
        }

        const records = protectedRecords.get(executorId);
        if (records !== undefined) {
          const root = yield* resolveWorktreeRoot(current);
          const currentHashes = new Map<string, string | null>();
          for (const record of records) {
            const hash = yield* hashFile(root, record.path);
            currentHashes.set(record.path, hash);
          }
          protectedPaths = {
            checked: records.length,
            changed: [...changedProtectedPaths(records, currentHashes)],
          };
        }
      }

      if (state !== "running") {
        yield* markDelegationObservationConsumed({
          parentId: scope.threadId,
          child: current,
        });
      }

      const result: PairAwaitResult = {
        threadId: executorId,
        state,
        waitedSeconds,
        hasPendingApprovals,
        hasPendingUserInput,
        lastError: current.session?.lastError ?? null,
        assistantMessage,
        filesChanged,
        turnCount,
        protectedPaths,
      };
      return result;
    });

  const pair_stop = () =>
    Effect.gen(function* () {
      const scope = yield* requirePairCapability;
      const executorId = yield* executorIdFor(scope.threadId);

      return yield* withLeadGate(scope.threadId)(
        Effect.gen(function* () {
          const existing = yield* findExecutor(executorId);
          if (Option.isNone(existing)) {
            return yield* new PairNotActiveError();
          }
          const shell = existing.value;
          const state = derivePairExecutorState(shell);
          if (state !== "running") {
            const result: PairStopResult = {
              threadId: executorId,
              interrupted: false,
              state,
            };
            return result;
          }

          const uuid = yield* orFail(crypto.randomUUIDv4);
          yield* engine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make(`server:mcp-pair-interrupt:${executorId}:${uuid}`),
              threadId: executorId,
              createdAt: yield* nowIso,
            })
            .pipe(mapDispatch(() => undefined));

          const result: PairStopResult = {
            threadId: executorId,
            interrupted: true,
            state,
          };
          return result;
        }),
      );
    });

  const pair_reset = () =>
    Effect.gen(function* () {
      const scope = yield* requirePairCapability;
      const executorId = yield* executorIdFor(scope.threadId);

      return yield* withLeadGate(scope.threadId)(
        Effect.gen(function* () {
          const existing = yield* findExecutor(executorId);
          if (Option.isNone(existing) || existing.value.archivedAt !== null) {
            return yield* new PairNotActiveError();
          }
          const executor = existing.value;
          const state = derivePairExecutorState(executor);
          if (state === "running") {
            return yield* new PairExecutorBusyError();
          }

          if (executor.latestTurn === null && executor.session === null) {
            const result: PairResetResult = {
              threadId: executorId,
              reset: false,
              state,
              providerInstanceId: executor.modelSelection.instanceId,
              model: executor.modelSelection.model,
            };
            return result;
          }

          const leadOpt = yield* orFail(snapshots.getThreadShellById(scope.threadId));
          if (Option.isNone(leadOpt)) {
            return yield* new PairLeadNotFoundError({ threadId: scope.threadId });
          }
          const lead = leadOpt.value;

          const uuid = yield* orFail(crypto.randomUUIDv4);
          const deleted = yield* engine
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.make(`server:mcp-pair-reset-delete:${executorId}:${uuid}`),
              threadId: executorId,
            })
            .pipe(mapDispatch(() => undefined));
          // The deletion reactor stops the old provider session. The new thread
          // reuses the id, so wait, or that stop could land on the new session.
          yield* orFail(deletionReactor.drainThrough(deleted.sequence));

          yield* engine
            .dispatch({
              type: "thread.create",
              commandId: CommandId.make(`server:mcp-pair-reset-create:${executorId}:${uuid}`),
              threadId: executorId,
              projectId: executor.projectId,
              title: executor.title,
              modelSelection: executor.modelSelection,
              runtimeMode: executor.runtimeMode,
              interactionMode: "default",
              branch: lead.branch,
              worktreePath: lead.worktreePath,
              createdAt: yield* nowIso,
            })
            .pipe(mapDispatch(() => undefined));

          protectedRecords.delete(executorId);

          const result: PairResetResult = {
            threadId: executorId,
            reset: true,
            state: "idle",
            providerInstanceId: executor.modelSelection.instanceId,
            model: executor.modelSelection.model,
          };
          return result;
        }),
      );
    });

  return PairToolkit.of({
    pair_start,
    pair_handoff,
    pair_await,
    pair_stop,
    pair_reset,
  });
});

export const PairToolkitHandlersLive = PairToolkit.toLayer(make);
