import {
  ApprovalRequestId,
  CommandId,
  ProviderThreadId,
  RuntimeSessionId,
  SessionInteractionRequestId,
  SessionInteractionResponse,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterEnsureThreadError,
  ProviderAdapterForkThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterProtocolError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
} from "../../orchestration-v2/ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../../orchestration-v2/ProviderAdapterDriver.ts";
import { makeProviderTextDeltaCoalescer } from "../../orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";
import { makeLegacyRuntimeEventProjector } from "./LegacyRuntimeEventProjector.ts";
import type { LegacyAdapterV2MaintenanceShape } from "./LegacyAdapterV2Maintenance.ts";
const decodeInteractionResponse = Schema.decodeUnknownEffect(SessionInteractionResponse);

/** Capability declarations shared by the bridge and contract regression tests. */
export function legacyAdapterV2Capabilities<Error>(
  adapter: ProviderAdapterShape<Error>,
): OrchestrationV2ProviderCapabilities {
  const rollback = adapter.capabilities.conversationRollback === "relative";
  return {
    sessions: {
      supportsMultipleProviderThreadsPerSession: false,
      supportsModelSwitchInSession: adapter.capabilities.sessionModelSwitch === "in-session",
      supportsProviderSwitchingViaHandoff: true,
      supportsRuntimeModeSwitchInSession: false,
      pendingRequestsSurviveRestart: false,
    },
    threads: {
      canCreateEmptyThread: true,
      canReadThreadSnapshot: true,
      canRollbackThread: rollback,
      canForkThread: false,
      canForkFromTurn: false,
      canForkFromSubagentThread: false,
      exposesNativeThreadId: true,
    },
    turns: {
      exposesNativeTurnId: true,
      emitsTurnStarted: true,
      emitsTurnCompleted: true,
      supportsInterrupt: true,
      supportsActiveSteering: false,
      supportsSteeringByInterruptRestart: true,
      supportsQueuedMessages: false,
      terminalStatusQuality: "strong",
    },
    streaming: {
      streamsAssistantText: true,
      streamsReasoning: true,
      streamsToolOutput: true,
      streamsPlanText: true,
      emitsMessageCompleted: true,
    },
    tools: {
      exposesToolItemIds: true,
      emitsToolStarted: true,
      emitsToolCompleted: true,
      emitsToolOutput: true,
      supportsMcpTools: true,
      supportsDynamicToolCallbacks: false,
    },
    approvals: {
      supportsCommandApproval: true,
      supportsFileReadApproval: true,
      supportsFileChangeApproval: true,
      supportsApplyPatchApproval: true,
      approvalsHaveNativeRequestIds: true,
      approvalCallbacksAreLiveOnly: true,
      approvalsCanOriginateFromSubagents: false,
    },
    planning: {
      emitsPlanUpdated: true,
      emitsTodoList: true,
      emitsProposedPlan: true,
      supportsStructuredQuestions: true,
      planDeltasHaveItemIds: false,
    },
    subagents: {
      supportsSubagents: true,
      exposesSubagentThreadIds: false,
      emitsSubagentLifecycle: true,
      canWaitForSubagents: false,
      canCloseSubagents: false,
      canForkSubagentThread: false,
    },
    context: {
      acceptsSystemContext: false,
      acceptsDeveloperContext: false,
      acceptsSyntheticUserContext: true,
      canGenerateSummaries: true,
      canConsumeHandoffSummaries: true,
      supportsDeltaHandoff: true,
      supportsFullThreadHandoff: true,
      maxRecommendedHandoffChars: null,
    },
    checkpointing: {
      appCanCheckpointFilesystem: true,
      supportsNestedCheckpointScopes: true,
      providerCanRollbackConversation: rollback,
      providerRollbackReturnsSnapshot: rollback,
      providerCanReadConversationSnapshot: true,
    },
    identity: {
      nativeThreadIds: "strong",
      nativeTurnIds: "strong",
      nativeItemIds: "weak",
      nativeRequestIds: "weak",
    },
    runtimePolicy: { enforcement: "client-boundary" },
  };
}

/** Pylon-owned translation boundary; the upstream orchestrator stays unchanged. */
export function makeLegacyAdapterV2<Error>(options: {
  readonly instanceId: ProviderInstanceId;
  readonly adapter: ProviderAdapterShape<Error>;
  /** Prime cursors are public continuation markers, not native session ids. */
  readonly resumeCursor?: unknown;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  readonly maintenance?: LegacyAdapterV2MaintenanceShape;
}): ProviderAdapterV2Shape {
  const adapter = options.adapter;
  const driver = adapter.provider;
  const capabilities = options.capabilities ?? legacyAdapterV2Capabilities(adapter);
  return {
    instanceId: options.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: (input) =>
      Effect.succeed(
        modelSelectionsEqual(input.current, input.target) ||
          adapter.capabilities.sessionModelSwitch === "in-session"
          ? { type: "apply_on_next_turn" }
          : { type: "restart_session" },
      ),
    openSession: Effect.fn("LegacyAdapterV2Bridge.openSession")(function* (input) {
      if (options.maintenance !== undefined)
        yield* options.maintenance.acquireRuntime(options.instanceId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
      const now = yield* DateTime.now;
      const sessionIncarnationId = RuntimeSessionId.make(input.providerSessionId);
      const providerSession: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver,
        providerInstanceId: options.instanceId,
        status: "starting",
        cwd: input.runtimePolicy.cwd ?? input.resumeFromSession?.cwd ?? process.cwd(),
        model: input.modelSelection.model,
        capabilities,
        createdAt: input.resumeFromSession?.createdAt ?? now,
        updatedAt: now,
        lastError: null,
      };
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make(`${input.providerSessionId}:thread`),
        driver,
        providerInstanceId: options.instanceId,
        providerSessionId: input.providerSessionId,
        appThreadId: input.threadId,
        ownerNodeId: null,
        nativeThreadRef:
          input.initialNativeThreadId === undefined
            ? null
            : { driver, nativeId: input.initialNativeThreadId, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projector = makeLegacyRuntimeEventProjector({ providerSession, providerThread });
      const events = yield* PubSub.unbounded<ProviderAdapterV2Event>({ replay: 32 });
      yield* Effect.addFinalizer(() => PubSub.shutdown(events));
      const publish = (event: ProviderRuntimeEvent) =>
        PubSub.publishAll(events, projector.project(event)).pipe(Effect.asVoid);
      const pendingTextEvents = new Map<string, ProviderRuntimeEvent>();
      const emittedText = new Map<string, string>();
      const seenLegacyEvents = new Set<string>();
      const textCoalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 40,
        emit: (update) => {
          const key = `${update.turnId}\u0000${update.itemId}`;
          const event = pendingTextEvents.get(key);
          if (event?.type !== "content.delta") return Effect.void;
          const previous = emittedText.get(key) ?? "";
          emittedText.set(key, update.text);
          return publish({
            ...event,
            payload: { ...event.payload, delta: update.text.slice(previous.length) },
          });
        },
      });
      const onLegacyEvent = Effect.fnUntraced(function* (event: ProviderRuntimeEvent) {
        if (
          event.threadId !== input.threadId ||
          event.provider !== driver ||
          (event.providerInstanceId !== undefined &&
            event.providerInstanceId !== options.instanceId) ||
          (event.sessionIncarnationId !== undefined &&
            event.sessionIncarnationId !== sessionIncarnationId)
        )
          return;
        if (seenLegacyEvents.has(event.eventId)) return;
        seenLegacyEvents.add(event.eventId);
        if (
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          event.turnId !== undefined &&
          event.itemId !== undefined
        ) {
          const key = `${event.turnId}\u0000${event.itemId}`;
          pendingTextEvents.set(key, event);
          yield* textCoalescer.append({
            turnId: event.turnId,
            itemId: event.itemId,
            delta: event.payload.delta,
          });
          return;
        }
        if (
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          event.turnId !== undefined &&
          event.itemId !== undefined
        ) {
          yield* textCoalescer.complete({
            turnId: event.turnId,
            itemId: event.itemId,
            emitEmpty: false,
          });
        }
        if (
          (event.type === "turn.completed" || event.type === "turn.aborted") &&
          event.turnId !== undefined
        )
          yield* textCoalescer.flushTurn(event.turnId);
        yield* publish(event);
      });
      // Subscribe before startSession: Prime can publish startup and turn
      // admission events before the corresponding method returns.
      yield* adapter.streamEvents.pipe(
        Stream.runForEach(onLegacyEvent),
        Effect.forkScoped({ startImmediately: true }),
      );
      const startInput: ProviderSessionStartInput = {
        threadId: input.threadId,
        provider: driver,
        providerInstanceId: options.instanceId,
        sessionIncarnationId,
        cwd: providerSession.cwd,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimePolicy.runtimeMode,
        ...(input.resumeFromSession === undefined && input.initialNativeThreadId === undefined
          ? {}
          : { resumeCursor: options.resumeCursor ?? input.initialNativeThreadId }),
      };
      const started = yield* adapter.startSession(startInput).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterOpenSessionError({
              driver,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      yield* Effect.addFinalizer(() =>
        adapter.stopSession(input.threadId).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Legacy provider session cleanup failed.", {
              driver,
              providerSessionId: input.providerSessionId,
              cause,
            }),
          ),
        ),
      );
      // Prime's recoverable daemon holds retained frames until the consumer
      // has installed incarnation fencing; this runtime is now that consumer.
      if (adapter.activateRecoveredSession !== undefined)
        yield* adapter.activateRecoveredSession(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
      const readySession = {
        ...projector.getProviderSession(),
        status: "ready" as const,
        model: started.model ?? providerSession.model,
        updatedAt: yield* DateTime.now,
      };
      let pendingHistory = "";
      const requireThread = (thread: OrchestrationV2ProviderThread) =>
        thread.appThreadId === input.threadId &&
        thread.providerInstanceId === options.instanceId &&
        thread.driver === driver;
      const runtime: ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: readySession,
        events: Stream.fromPubSub(events),
        hasPendingBackgroundWork: Effect.sync(projector.hasPendingBackgroundWork),
        hasPendingBackgroundWorkForThread: () => Effect.sync(projector.hasPendingBackgroundWork),
        ensureThread: (ensureInput) =>
          Effect.gen(function* () {
            if (ensureInput.threadId !== input.threadId)
              return yield* new ProviderAdapterEnsureThreadError({
                driver,
                threadId: ensureInput.threadId,
                cause: new Error("A legacy runtime owns exactly one app thread."),
              });
            if (ensureInput.existingProviderThread !== undefined) {
              if (!requireThread(ensureInput.existingProviderThread))
                return yield* new ProviderAdapterEnsureThreadError({
                  driver,
                  threadId: ensureInput.threadId,
                  cause: new Error(
                    "The persisted provider thread belongs to another legacy runtime.",
                  ),
                });
              projector.setProviderThread({
                ...ensureInput.existingProviderThread,
                providerSessionId: input.providerSessionId,
                status: "idle",
                updatedAt: yield* DateTime.now,
              });
            }
            return projector.getProviderThread();
          }),
        resumeThread: (resumeInput) =>
          Effect.gen(function* () {
            if (!requireThread(resumeInput.providerThread))
              return yield* new ProviderAdapterResumeThreadError({
                driver,
                providerSessionId: input.providerSessionId,
                providerThreadId: resumeInput.providerThread.id,
                cause: new Error(
                  "The persisted provider thread belongs to another legacy runtime.",
                ),
              });
            const thread = {
              ...resumeInput.providerThread,
              providerSessionId: input.providerSessionId,
              status: "idle" as const,
              updatedAt: yield* DateTime.now,
            };
            projector.setProviderThread(thread);
            return thread;
          }),
        injectHistory: (history) =>
          Effect.sync(() => {
            pendingHistory = history.context;
            return true;
          }),
        startTurn: Effect.fn("LegacyAdapterV2Bridge.startTurn")(function* (turnInput) {
          if (!requireThread(turnInput.providerThread))
            return yield* new ProviderAdapterTurnStartError({
              driver,
              threadId: turnInput.threadId,
              providerThreadId: turnInput.providerThread.id,
              runId: turnInput.runId,
              cause: new Error("The turn does not belong to this legacy runtime."),
            });
          projector.setProviderThread(turnInput.providerThread);
          projector.prepareTurn(turnInput);
          const turnText =
            pendingHistory.length === 0
              ? turnInput.message.text
              : `${pendingHistory}\n\n${turnInput.message.text}`;
          const sendInput = {
            threadId: input.threadId,
            ...(turnText.trim().length === 0
              ? { continuation: adapter.capabilities.promptlessTurnContinuation === true }
              : { input: turnText }),
            attachments: turnInput.message.attachments,
            modelSelection: turnInput.modelSelection,
            interactionMode: turnInput.runtimePolicy.interactionMode,
            admissionRequestId: CommandId.make(turnInput.runId),
            sessionIncarnationId,
          };
          const submit = Effect.gen(function* () {
            if (adapter.prepareTurnRecovery !== undefined)
              yield* adapter.prepareTurnRecovery(sendInput);
            yield* adapter.sendTurn(sendInput);
          });
          yield* submit.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterTurnStartError({
                  driver,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          );
          pendingHistory = "";
        }),
        steerTurn: (steerInput) =>
          Effect.fail(
            new ProviderAdapterSteerRunUnsupportedError({
              driver,
              providerThreadId: steerInput.providerThread.id,
            }),
          ),
        interruptTurn: (interruptInput) =>
          Effect.gen(function* () {
            const turnId = projector.getLegacyTurnId(interruptInput.providerTurnId);
            if (!requireThread(interruptInput.providerThread) || turnId === undefined)
              return yield* new ProviderAdapterInterruptError({
                driver,
                providerThreadId: interruptInput.providerThread.id,
                providerTurnId: interruptInput.providerTurnId,
                cause: new Error("The provider turn is unknown in this legacy runtime."),
              });
            yield* adapter.interruptTurn(input.threadId, turnId).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterInterruptError({
                    driver,
                    providerThreadId: interruptInput.providerThread.id,
                    providerTurnId: interruptInput.providerTurnId,
                    cause,
                  }),
              ),
            );
          }),
        respondToRuntimeRequest: Effect.fn("LegacyAdapterV2Bridge.respondToRuntimeRequest")(
          function* (responseInput) {
            const route = projector.getRequestRoute(responseInput.requestId);
            if (
              route === undefined ||
              projector.getRuntimeRequest(responseInput.requestId)?.status !== "pending"
            )
              return yield* new ProviderAdapterRuntimeRequestResponseError({
                driver,
                requestId: responseInput.requestId,
                cause: new Error("The legacy request is not pending in this session incarnation."),
              });
            const respond = Effect.gen(function* () {
              if (route.kind === "approval" && responseInput.decision !== undefined)
                return yield* adapter.respondToRequest(
                  input.threadId,
                  ApprovalRequestId.make(route.legacyRequestId),
                  responseInput.decision,
                );
              if (route.kind === "user_input" && responseInput.answers !== undefined)
                return yield* adapter.respondToUserInput(
                  input.threadId,
                  ApprovalRequestId.make(route.legacyRequestId),
                  responseInput.answers,
                );
              if (
                route.kind === "interaction" &&
                adapter.respondToInteraction !== undefined &&
                route.interaction !== undefined
              ) {
                const selected = responseInput.answers?.interaction;
                const value =
                  typeof selected === "string"
                    ? selected
                    : Array.isArray(selected) && typeof selected[0] === "string"
                      ? selected[0]
                      : undefined;
                const interaction = route.interaction;
                const rawResponse =
                  responseInput.response ??
                  (value === undefined
                    ? { kind: "cancelled" }
                    : interaction.kind === "select"
                      ? { kind: "selected", value }
                      : interaction.kind === "confirm"
                        ? { kind: "confirmed", confirmed: value === "Confirm" }
                        : { kind: "submitted", value });
                const response = yield* decodeInteractionResponse(rawResponse).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterProtocolError({
                        driver,
                        detail: "Invalid legacy session interaction response.",
                        cause,
                      }),
                  ),
                );
                return yield* adapter.respondToInteraction(
                  input.threadId,
                  SessionInteractionRequestId.make(route.legacyRequestId),
                  response,
                );
              }
              return yield* new ProviderAdapterProtocolError({
                driver,
                detail: "The response does not match the pending legacy runtime request.",
              });
            });
            yield* respond.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRuntimeRequestResponseError({
                    driver,
                    requestId: responseInput.requestId,
                    cause,
                  }),
              ),
            );
          },
        ),
        readThreadSnapshot: (snapshotInput) =>
          adapter.readThread(input.threadId).pipe(
            Effect.map((providerPayload) => ({ ...projector.snapshot(), providerPayload })),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterReadThreadSnapshotError({
                  driver,
                  providerThreadId: snapshotInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        rollbackThread: (rollbackInput) =>
          Effect.gen(function* () {
            const targetOrdinal =
              rollbackInput.target.type === "thread_start"
                ? 0
                : rollbackInput.target.providerTurn.ordinal;
            const removeCount = rollbackInput.providerThreadTurns.filter(
              (turn) => turn.ordinal > targetOrdinal,
            ).length;
            if (removeCount > 0) yield* adapter.rollbackThread(input.threadId, removeCount);
            projector.rollbackThroughOrdinal(targetOrdinal);
            return projector.snapshot();
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRollbackThreadError({
                  driver,
                  providerThreadId: rollbackInput.providerThread.id,
                  checkpointId: rollbackInput.target.checkpointId,
                  cause,
                }),
            ),
          ),
        forkThread: (forkInput) =>
          Effect.fail(
            new ProviderAdapterForkThreadError({
              driver,
              providerThreadId: forkInput.sourceProviderThread.id,
              cause: new Error("The legacy adapter does not expose native conversation forks."),
            }),
          ),
      };
      return runtime;
    }),
  };
}

/** Bridges a legacy driver factory without importing v1 orchestration wiring. */
export function makeLegacyAdapterV2Driver<Config, Error, Environment>(legacyDriver: {
  readonly driverKind: ProviderAdapterDriver<Config, Environment>["driverKind"];
  readonly configSchema: ProviderAdapterDriver<Config, Environment>["configSchema"];
  readonly defaultConfig: () => Config;
  readonly create: (
    input: ProviderAdapterDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderAdapterShape<Error>, Error, Environment>;
}): ProviderAdapterDriver<Config, Environment> {
  return {
    driverKind: legacyDriver.driverKind,
    configSchema: legacyDriver.configSchema,
    defaultConfig: legacyDriver.defaultConfig,
    create: (input) =>
      legacyDriver.create(input).pipe(
        Effect.map((adapter) => makeLegacyAdapterV2({ instanceId: input.instanceId, adapter })),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: legacyDriver.driverKind,
              instanceId: input.instanceId,
              detail: "Legacy adapter construction failed.",
              cause,
            }),
        ),
      ),
  };
}
