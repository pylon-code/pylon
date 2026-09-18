/**
 * Delegation MCP toolkit handlers.
 *
 * A sidecar over existing orchestration: every write is an existing command
 * and every read is an existing projection. Creates, meta updates, and turn
 * starts use deterministic ids so the command receipt store absorbs retries;
 * deletes and interrupts use a unique id per call. Child ownership and depth come from
 * the child's id (see `logic.ts`), never from a lookup.
 *
 * @module mcp/toolkits/delegation/handlers
 */
import { pairExecutorThreadId } from "@t3tools/shared/delegatedThreads";
import {
  CommandId,
  MessageId,
  getServerProviderSupportedRuntimeModes,
  isProviderAvailable,
  type OrchestrationThreadShell,
  type ProjectId,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../../config.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import type { OrchestrationDispatchError } from "../../../orchestration/Errors.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import { markDelegationObservationConsumed } from "../../../orchestration/delegationObservationConsumed.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadDeletionReactor from "../../../orchestration/Services/ThreadDeletionReactor.ts";
import { PAIR_LEAD_PROTOCOL } from "../../../provider/RuntimeInstructions.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  aggregateFilesChanged,
  defaultTitleFor,
  delegatedThreadId,
  deriveDelegatedThreadState,
  isChildOfParent,
  isDelegatedThreadId,
  isLiveDelegatedState,
  isValidDelegationKey,
  MAX_LIVE_CHILDREN,
  resolveDelegatedModel,
  resolveDelegatedRuntimeMode,
  resolveDelegationTarget,
  selectAssistantMessage,
  truncateText,
} from "./logic.ts";
import { PAIR_DELEGATION_KEY } from "../pair/logic.ts";
import { delegationSkill } from "./skill.ts";
import {
  DelegatedMessageKeyConsumedError,
  DelegatedThreadArchivedError,
  DelegatedThreadBusyError,
  DelegatedThreadNotFoundError,
  DelegatedThreadTurnRejectedError,
  DelegatingThreadNotFoundError,
  DelegationDefaultMissingError,
  DelegationDepthExceededError,
  DelegationPairedError,
  DelegationFailedError,
  DelegationKeyConsumedError,
  DelegationKeyInvalidError,
  DelegationKeyReservedError,
  DelegationLimitExceededError,
  DelegationModelUnavailableError,
  DelegationProviderUnavailableError,
  DelegationRuntimeModeEscalationError,
  DelegationRuntimeModeUnsupportedError,
  DelegationToolkit,
  type DelegateThreadResult,
  type DelegatedThreadStatusResult,
} from "./tools.ts";
import { prepareChildWorktree, removeChildWorktree } from "./worktree.ts";

const DEFAULT_RESULT_CHARS = 4_000;
const POLL_INTERVAL_MS = 1_000;
const INITIAL_MESSAGE_KEY = "initial";

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const initialMessageIdFor = (childId: ThreadId) =>
  MessageId.make(`delegated-message:${childId}:${INITIAL_MESSAGE_KEY}`);

/** Interrupts pass through; any other cause becomes the generic delegation failure. */
const orFail = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, DelegationFailedError, R> =>
  effect.pipe(
    Effect.catchCause((cause): Effect.Effect<never, DelegationFailedError> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new DelegationFailedError({ cause })),
    ),
  );

type DispatchRejection =
  | DelegationKeyConsumedError
  | DelegatedThreadTurnRejectedError
  | DelegatedMessageKeyConsumedError;

/**
 * Maps specific dispatch rejections to delegation errors the agent can act on.
 * Everything unmapped becomes the generic failure; interrupts pass through.
 */
const mapDispatch =
  (map: (error: OrchestrationDispatchError) => DispatchRejection | undefined) =>
  <A, R>(
    effect: Effect.Effect<A, OrchestrationDispatchError, R>,
  ): Effect.Effect<A, DispatchRejection | DelegationFailedError, R> =>
    effect.pipe(
      Effect.catchCause(
        (cause): Effect.Effect<never, DispatchRejection | DelegationFailedError> => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
          const error = Cause.findErrorOption(cause);
          const mapped = Option.isSome(error) ? map(error.value) : undefined;
          return Effect.fail(mapped ?? new DelegationFailedError({ cause }));
        },
      ),
    );

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const deletionReactor = yield* ThreadDeletionReactor.ThreadDeletionReactor;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const config = yield* ServerConfig;

  /** A pair is on while its executor thread exists and is not archived. */
  const isPaired = (threadId: ThreadId) =>
    orFail(snapshots.getThreadShellById(pairExecutorThreadId(threadId))).pipe(
      Effect.map((executor) => Option.isSome(executor) && executor.value.archivedAt === null),
    );
  const crypto = yield* Crypto.Crypto;

  // One permit per parent: providers issue tool calls in parallel, and the
  // live-children limit and the busy check are check-then-act.
  const gates = new Map<ThreadId, Semaphore.Semaphore>();
  const withParentGate =
    (parentId: ThreadId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        let gate = gates.get(parentId);
        if (gate === undefined) {
          gate = Semaphore.makeUnsafe(1);
          gates.set(parentId, gate);
        }
        return gate.withPermits(1)(effect);
      });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const requireKey = (field: "delegationKey" | "messageKey", value: string) => {
    if (!isValidDelegationKey(value)) {
      return Effect.fail(new DelegationKeyInvalidError({ field }));
    }
    if (field === "delegationKey" && value === PAIR_DELEGATION_KEY) {
      return Effect.fail(new DelegationKeyReservedError({ delegationKey: value }));
    }
    return Effect.void;
  };

  const childIdFor = Effect.fn("DelegationToolkit.childIdFor")(function* (
    parentId: ThreadId,
    delegationKey: string,
  ) {
    const digest = yield* orFail(
      crypto.digest("SHA-256", new TextEncoder().encode(`${parentId}\n${delegationKey}`)),
    );
    const hex = bytesToHex(digest);
    return delegatedThreadId(parentId, delegationKey, () => hex);
  });

  /** Active first, then archived; `None` when neither knows the id. */
  const findChild = (childId: ThreadId) =>
    orFail(
      snapshots
        .getThreadShellById(childId)
        .pipe(
          Effect.filterOrElse(Option.isSome, () =>
            snapshots
              .getArchivedShellSnapshot()
              .pipe(
                Effect.map((snapshot) =>
                  Option.fromNullishOr(snapshot.threads.find((thread) => thread.id === childId)),
                ),
              ),
          ),
        ),
    );

  /** Capability, key, and child lookup shared by every tool that addresses an existing child. */
  const lookupChild = Effect.fn("DelegationToolkit.lookupChild")(function* (delegationKey: string) {
    const scope = yield* McpInvocationContext.requireMcpCapability("delegation");
    yield* requireKey("delegationKey", delegationKey);
    const childId = yield* childIdFor(scope.threadId, delegationKey);
    const found = yield* findChild(childId);
    if (Option.isNone(found)) return yield* new DelegatedThreadNotFoundError({ delegationKey });
    return { scope, childId, shell: found.value };
  });

  const isManagedWorktreePath = (path: string) => {
    const root = config.worktreesDir.endsWith("/")
      ? config.worktreesDir
      : `${config.worktreesDir}/`;
    return path.startsWith(root) && !path.slice(root.length).split("/").includes("..");
  };

  const removeWorktree = (projectCwd: string, path: string) =>
    removeChildWorktree({ projectCwd, path }).pipe(
      Effect.provideService(GitWorkflowService.GitWorkflowService, git),
    );

  /** Remove the child's worktree when known, then delete the thread. Never fails. */
  const discardChild = (input: {
    readonly childId: ThreadId;
    readonly projectCwd: string | null;
    readonly worktreePath: string | null;
  }) =>
    Effect.gen(function* () {
      // Force removal only ever touches Pylon-managed worktrees. A thread can
      // record any path, including a checkout another thread uses.
      if (
        input.projectCwd !== null &&
        input.worktreePath !== null &&
        isManagedWorktreePath(input.worktreePath)
      ) {
        yield* removeWorktree(input.projectCwd, input.worktreePath);
      }
      // Unique per discard: a deterministic id would replay as success
      // without deleting if the same child id were ever created again.
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.catch(() => Clock.currentTimeMillis.pipe(Effect.map(String))),
      );
      yield* engine
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`server:mcp-delegate-delete:${input.childId}:${uuid}`),
          threadId: input.childId,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }).pipe(Effect.uninterruptible);

  const projectCwdOf = (projectId: ProjectId) =>
    orFail(snapshots.getProjectShellById(projectId)).pipe(
      Effect.map((project) => (Option.isSome(project) ? project.value.workspaceRoot : null)),
    );

  const statusOf = (shell: OrchestrationThreadShell) => ({
    state: deriveDelegatedThreadState(shell),
    hasPendingApprovals: shell.hasPendingApprovals,
    hasPendingUserInput: shell.hasPendingUserInput,
  });

  const statusPayload = (
    delegationKey: string,
    shell: OrchestrationThreadShell,
    waitedSeconds: number,
    changed: boolean,
  ): DelegatedThreadStatusResult => ({
    delegationKey,
    threadId: shell.id,
    ...statusOf(shell),
    waitedSeconds,
    changed,
    latestTurn:
      shell.latestTurn === null
        ? null
        : {
            turnId: shell.latestTurn.turnId,
            state: shell.latestTurn.state,
            requestedAt: shell.latestTurn.requestedAt,
            startedAt: shell.latestTurn.startedAt,
            completedAt: shell.latestTurn.completedAt,
          },
    session:
      shell.session === null
        ? null
        : { status: shell.session.status, lastError: shell.session.lastError },
    backgroundLiveness: shell.backgroundLiveness ?? null,
  });

  const existingResult = (
    delegationKey: string,
    shell: OrchestrationThreadShell,
  ): DelegateThreadResult => ({
    delegationKey,
    threadId: shell.id,
    created: false,
    state: deriveDelegatedThreadState(shell),
    providerInstanceId: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    worktreePath: shell.worktreePath,
    branch: shell.branch,
    startedFromOrigin: false,
    setupScriptRan: false,
  });

  const countLiveChildren = (parentId: ThreadId) =>
    orFail(snapshots.getShellSnapshot()).pipe(
      Effect.map(
        (snapshot) =>
          snapshot.threads.filter(
            (thread) =>
              isChildOfParent(thread.id, parentId) &&
              isLiveDelegatedState(deriveDelegatedThreadState(thread)),
          ).length,
      ),
    );

  const delegated_thread_status = (input: {
    readonly delegationKey: string;
    readonly waitSeconds?: number | undefined;
  }) =>
    Effect.gen(function* () {
      const { scope, childId, shell } = yield* lookupChild(input.delegationKey);
      const initial = statusOf(shell);
      // A settled child or an actionable blocker needs attention now, not a
      // state transition. In particular, do not spend the entire wait budget
      // on a child that finished before the caller checked it.
      if (
        !isLiveDelegatedState(initial.state) ||
        initial.hasPendingApprovals ||
        initial.hasPendingUserInput
      ) {
        yield* markDelegationObservationConsumed({ parentId: scope.threadId, child: shell });
        return statusPayload(input.delegationKey, shell, 0, false);
      }
      const startedAt = yield* Clock.currentTimeMillis;
      // Wall-clock bound: each poll's query time counts against the budget so
      // the call always returns inside the caller's tool timeout.
      const deadline = startedAt + (input.waitSeconds ?? 0) * 1_000;
      const elapsedSeconds = (now: number) => Math.round((now - startedAt) / 1_000);
      let current = shell;
      let now = startedAt;
      while (now < deadline) {
        yield* Effect.sleep(Math.min(POLL_INTERVAL_MS, deadline - now));
        const next = yield* findChild(childId);
        now = yield* Clock.currentTimeMillis;
        if (Option.isNone(next)) {
          return yield* new DelegatedThreadNotFoundError({ delegationKey: input.delegationKey });
        }
        current = next.value;
        const latest = statusOf(current);
        if (
          latest.state !== initial.state ||
          latest.hasPendingApprovals !== initial.hasPendingApprovals ||
          latest.hasPendingUserInput !== initial.hasPendingUserInput
        ) {
          yield* markDelegationObservationConsumed({ parentId: scope.threadId, child: current });
          return statusPayload(input.delegationKey, current, elapsedSeconds(now), true);
        }
      }
      yield* markDelegationObservationConsumed({ parentId: scope.threadId, child: current });
      return statusPayload(input.delegationKey, current, elapsedSeconds(now), false);
    });

  const delegated_thread_result = (input: {
    readonly delegationKey: string;
    readonly maxChars?: number | undefined;
  }) =>
    Effect.gen(function* () {
      const { scope, childId, shell } = yield* lookupChild(input.delegationKey);
      const state = deriveDelegatedThreadState(shell);
      yield* markDelegationObservationConsumed({ parentId: scope.threadId, child: shell });
      // The detail query serves active threads only, so an archived child has no body here.
      const detail =
        state === "archived"
          ? Option.none()
          : yield* orFail(snapshots.getThreadDetailById(childId));
      if (Option.isNone(detail)) {
        return {
          delegationKey: input.delegationKey,
          threadId: childId,
          state,
          assistantMessage: null,
          filesChanged: [],
          turnCount: 0,
          worktreePath: shell.worktreePath,
          branch: shell.branch,
        };
      }
      const message = selectAssistantMessage(detail.value);
      const body =
        message === null
          ? null
          : truncateText(message.text, input.maxChars ?? DEFAULT_RESULT_CHARS);
      return {
        delegationKey: input.delegationKey,
        threadId: childId,
        state,
        assistantMessage:
          message === null || body === null
            ? null
            : {
                messageId: message.id,
                text: body.text,
                truncated: body.truncated,
                createdAt: message.createdAt,
              },
        filesChanged: aggregateFilesChanged(detail.value.checkpoints),
        turnCount: detail.value.checkpoints.length,
        worktreePath: shell.worktreePath,
        branch: shell.branch,
      };
    });

  const delegate_thread = (input: {
    readonly delegationKey: string;
    readonly task: string;
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly model?: string | undefined;
    readonly title?: string | undefined;
    readonly runtimeMode?: RuntimeMode | undefined;
  }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("delegation");
      yield* requireKey("delegationKey", input.delegationKey);
      if (isDelegatedThreadId(scope.threadId)) {
        return yield* new DelegationDepthExceededError({ threadId: scope.threadId });
      }
      if (yield* isPaired(scope.threadId)) {
        return yield* new DelegationPairedError({ threadId: scope.threadId });
      }
      const childId = yield* childIdFor(scope.threadId, input.delegationKey);
      const initialMessageId = initialMessageIdFor(childId);

      return yield* withParentGate(scope.threadId)(
        Effect.gen(function* () {
          const existing = yield* findChild(childId);
          if (Option.isSome(existing)) {
            const shell = existing.value;
            if (shell.archivedAt !== null) return existingResult(input.delegationKey, shell);
            const started = yield* orFail(
              snapshots.getTurnStartMessage({ threadId: childId, messageId: initialMessageId }),
            );
            // Only an attempt that demonstrably never ran is discarded: no
            // initial message, no session, no turn, and no rollback. A user
            // rewinding the child's first message also removes that message,
            // but leaves a session and a later source epoch behind.
            const neverRan =
              Option.isNone(started) &&
              shell.session === null &&
              shell.latestTurn === null &&
              (shell.sourceEpoch ?? 0) === 0;
            if (!neverRan) return existingResult(input.delegationKey, shell);
            yield* discardChild({
              childId,
              projectCwd: yield* projectCwdOf(shell.projectId),
              worktreePath: shell.worktreePath,
            });
            return yield* new DelegationKeyConsumedError({ delegationKey: input.delegationKey });
          }

          const parent = yield* orFail(snapshots.getThreadShellById(scope.threadId));
          if (Option.isNone(parent)) {
            return yield* new DelegatingThreadNotFoundError({ threadId: scope.threadId });
          }
          const project = yield* orFail(snapshots.getProjectShellById(parent.value.projectId));
          if (Option.isNone(project)) {
            return yield* new DelegatingThreadNotFoundError({ threadId: scope.threadId });
          }

          // Defaults come from the parent's project, falling back to the environment.
          const settings = yield* orFail(serverSettings.getSettings);
          const projectSettings = resolveProjectSettings(settings, project.value.id).settings;
          const target = resolveDelegationTarget({
            defaultSelection: projectSettings.delegationDefaultModelSelection,
            requestedInstanceId: input.providerInstanceId,
            requestedModel: input.model,
          });
          if (!target.ok) return yield* new DelegationDefaultMissingError();

          const snapshot = (yield* providers.getProviders).find(
            (provider) => provider.instanceId === target.instanceId,
          );
          if (
            snapshot === undefined ||
            !snapshot.enabled ||
            !isProviderAvailable(snapshot) ||
            snapshot.auth.status === "unauthenticated"
          ) {
            return yield* new DelegationProviderUnavailableError({
              providerInstanceId: target.instanceId,
            });
          }
          // A default is validated exactly like an explicit choice: a model the
          // provider no longer offers fails rather than falling back.
          const model = resolveDelegatedModel(snapshot, target.model);
          if (!model.ok) {
            return yield* new DelegationModelUnavailableError({
              providerInstanceId: target.instanceId,
              model: target.model ?? null,
            });
          }
          const parentMode = parent.value.runtimeMode;
          const mode = resolveDelegatedRuntimeMode(
            parentMode,
            input.runtimeMode,
            projectSettings.delegationChildRuntimeMode,
          );
          if (!mode.ok) {
            return yield* new DelegationRuntimeModeEscalationError({
              parentMode,
              requested: input.runtimeMode ?? parentMode,
            });
          }
          if (!getServerProviderSupportedRuntimeModes(snapshot).includes(mode.mode)) {
            return yield* new DelegationRuntimeModeUnsupportedError({
              providerInstanceId: target.instanceId,
              runtimeMode: mode.mode,
            });
          }
          if ((yield* countLiveChildren(scope.threadId)) >= MAX_LIVE_CHILDREN) {
            return yield* new DelegationLimitExceededError({ limit: MAX_LIVE_CHILDREN });
          }

          const startFromOrigin = projectSettings.newWorktreesStartFromOrigin;
          const projectCwd = project.value.workspaceRoot;
          // Model options (such as thinking level) are carried only when the
          // default supplied the model; a named model uses its own defaults.
          const modelSelection = {
            instanceId: target.instanceId,
            model: model.model,
            ...(target.defaultApplied === "provider-and-model" && target.options !== undefined
              ? { options: target.options }
              : {}),
          };

          // Set inside the uninterruptible steps that create each resource, so
          // cleanup never misses something that exists.
          let threadCreated = false;
          let worktreePath: string | null = null;

          const build = Effect.gen(function* () {
            const created = yield* engine
              .dispatch({
                type: "thread.create",
                commandId: CommandId.make(`server:mcp-delegate-create:${childId}`),
                threadId: childId,
                projectId: project.value.id,
                title: input.title ?? defaultTitleFor(input.task),
                modelSelection,
                runtimeMode: mode.mode,
                interactionMode: parent.value.interactionMode,
                branch: null,
                worktreePath: null,
                createdAt: yield* nowIso,
              })
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    threadCreated = true;
                  }),
                ),
                Effect.uninterruptible,
                mapDispatch((error) =>
                  error._tag === "OrchestrationCommandPreviouslyRejectedError"
                    ? new DelegationKeyConsumedError({ delegationKey: input.delegationKey })
                    : undefined,
                ),
              );
            yield* deletionReactor.drainThrough(created.sequence);
            // An accepted receipt replayed onto a missing thread is an attempt
            // that was already cleaned up; there is nothing of ours to discard.
            if (Option.isNone(yield* findChild(childId))) {
              threadCreated = false;
              return yield* new DelegationKeyConsumedError({ delegationKey: input.delegationKey });
            }

            const uuid = yield* orFail(crypto.randomUUIDv4);
            const worktree = yield* prepareChildWorktree({
              projectCwd,
              parentBranch: parent.value.branch,
              startFromOrigin,
              randomHex: () => uuid.replaceAll("-", ""),
              onWorktreeCreated: (path) => {
                worktreePath = path;
              },
            }).pipe(Effect.provideService(GitWorkflowService.GitWorkflowService, git));

            yield* engine
              .dispatch({
                type: "thread.meta.update",
                commandId: CommandId.make(`server:mcp-delegate-meta:${childId}`),
                threadId: childId,
                branch: worktree.branch,
                worktreePath: worktree.path,
              })
              .pipe(mapDispatch(() => undefined));
            yield* vcsStatus
              .refreshStatus(worktree.path)
              .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

            yield* engine
              .dispatch({
                type: "thread.turn.start",
                commandId: CommandId.make(
                  `server:mcp-delegate-turn:${childId}:${INITIAL_MESSAGE_KEY}`,
                ),
                threadId: childId,
                message: {
                  messageId: initialMessageId,
                  role: "user",
                  text: input.task,
                  attachments: [],
                },
                modelSelection,
                runtimeMode: mode.mode,
                interactionMode: parent.value.interactionMode,
                sourceEpoch: 0,
                createdAt: yield* nowIso,
              })
              .pipe(
                mapDispatch((error) =>
                  error._tag === "OrchestrationCommandInvariantError" ||
                  error._tag === "OrchestrationCommandPreviouslyRejectedError"
                    ? new DelegatedThreadTurnRejectedError({ detail: error.detail })
                    : undefined,
                ),
              );
            return worktree;
          });

          // onExit sees typed failures, defects, and interrupts alike, so every
          // unsuccessful path after thread.create runs the same cleanup.
          const worktree = yield* build.pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) && threadCreated
                ? discardChild({ childId, projectCwd, worktreePath })
                : Effect.void,
            ),
          );

          const current = yield* findChild(childId);
          return {
            delegationKey: input.delegationKey,
            threadId: childId,
            created: true,
            state: Option.isSome(current) ? deriveDelegatedThreadState(current.value) : "queued",
            providerInstanceId: target.instanceId,
            model: model.model,
            runtimeMode: mode.mode,
            defaultApplied: target.defaultApplied,
            worktreePath: worktree.path,
            branch: worktree.branch,
            startedFromOrigin: worktree.startedFromOrigin,
            setupScriptRan: false,
          } satisfies DelegateThreadResult;
        }),
      );
    });

  const send_to_delegated_thread = (input: {
    readonly delegationKey: string;
    readonly messageKey: string;
    readonly text: string;
  }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("delegation");
      yield* requireKey("delegationKey", input.delegationKey);
      yield* requireKey("messageKey", input.messageKey);
      return yield* withParentGate(scope.threadId)(
        Effect.gen(function* () {
          // Read inside the gate so the busy check sees this parent's earlier sends.
          const { childId, shell } = yield* lookupChild(input.delegationKey);
          const state = deriveDelegatedThreadState(shell);
          if (state === "archived") {
            return yield* new DelegatedThreadArchivedError({ delegationKey: input.delegationKey });
          }
          if (isLiveDelegatedState(state)) {
            return yield* new DelegatedThreadBusyError({
              delegationKey: input.delegationKey,
              state,
            });
          }
          const messageId = MessageId.make(`delegated-message:${childId}:${input.messageKey}`);
          const accepted = {
            delegationKey: input.delegationKey,
            threadId: childId,
            accepted: true as const,
            messageId,
          };
          const existing = yield* orFail(
            snapshots.getTurnStartMessage({ threadId: childId, messageId }),
          );
          if (Option.isSome(existing)) return accepted;
          yield* engine
            .dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make(`server:mcp-delegate-turn:${childId}:${input.messageKey}`),
              threadId: childId,
              message: { messageId, role: "user", text: input.text, attachments: [] },
              modelSelection: shell.modelSelection,
              runtimeMode: shell.runtimeMode,
              interactionMode: shell.interactionMode,
              sourceEpoch: shell.sourceEpoch ?? 0,
              createdAt: yield* nowIso,
            })
            .pipe(
              mapDispatch((error) =>
                error._tag === "OrchestrationCommandPreviouslyRejectedError"
                  ? new DelegatedMessageKeyConsumedError({ messageKey: input.messageKey })
                  : error._tag === "OrchestrationCommandInvariantError"
                    ? new DelegatedThreadTurnRejectedError({ detail: error.detail })
                    : undefined,
              ),
            );
          return accepted;
        }),
      );
    });

  const interrupt_delegated_thread = (input: { readonly delegationKey: string }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("delegation");
      yield* requireKey("delegationKey", input.delegationKey);
      // Gated so an interrupt cannot land between a child's creation and its
      // first turn start inside a concurrent delegate_thread.
      return yield* withParentGate(scope.threadId)(
        Effect.gen(function* () {
          const { childId, shell } = yield* lookupChild(input.delegationKey);
          const state = deriveDelegatedThreadState(shell);
          if (!isLiveDelegatedState(state)) {
            return {
              delegationKey: input.delegationKey,
              threadId: childId,
              interrupted: false,
              state,
            };
          }
          // A unique id per call. Interrupting a live child twice is harmless,
          // while any id shared across calls (per turn or per admission) can
          // replay an earlier receipt and silently dispatch nothing.
          const uuid = yield* orFail(crypto.randomUUIDv4);
          yield* engine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make(`server:mcp-delegate-interrupt:${childId}:${uuid}`),
              threadId: childId,
              createdAt: yield* nowIso,
            })
            .pipe(mapDispatch(() => undefined));
          return {
            delegationKey: input.delegationKey,
            threadId: childId,
            interrupted: true,
            state,
          };
        }),
      );
    });

  return DelegationToolkit.of({
    read_delegation_skill: () =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("delegation");
        const parent = yield* orFail(snapshots.getThreadShellById(scope.threadId));
        if (Option.isNone(parent))
          return yield* new DelegatingThreadNotFoundError({ threadId: scope.threadId });
        // A paired thread hands work to its executor; the fan-out workflow would
        // send it straight past the pair.
        if (yield* isPaired(scope.threadId)) {
          return `This thread is paired. Delegating here means briefing the executor.\n\n${PAIR_LEAD_PROTOCOL}`;
        }
        const settings = yield* orFail(serverSettings.getSettings);
        const effective = resolveProjectSettings(settings, parent.value.projectId).settings;
        const preference = effective.enableAgentDelegation
          ? effective.delegationPreference
          : "built-in";
        return `Current preferred delegation method: ${preference}. Explicit user instructions override this preference. Small or tightly coupled work stays local.\n\n${delegationSkill}`;
      }),
    delegate_thread,
    delegated_thread_status,
    delegated_thread_result,
    send_to_delegated_thread,
    interrupt_delegated_thread,
  });
});

export const DelegationToolkitHandlersLive = DelegationToolkit.toLayer(make);
