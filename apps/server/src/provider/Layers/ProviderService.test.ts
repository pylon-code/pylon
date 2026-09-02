// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderFollowUpInput,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
  SessionCompactionUpdatedPayload,
  SessionInputQueueUpdatedPayload,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ProviderSessionSideQuestionRequestId,
  SessionInteractionRequestId,
  RuntimeTaskId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it, assert, describe, vi } from "@effect/vitest";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";

const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest();
const serverConfigTestLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provide(NodeServices.layer),
);

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeAgentInstanceId = ProviderInstanceId.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function makeFakeCodexAdapter(
  provider: ProviderDriverKind = CODEX_DRIVER,
  options?: { readonly supportsSideQuestions?: boolean },
) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn(
    (input: ProviderSessionStartInput): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      Effect.sync(() => {
        const now = "2026-01-01T00:00:00.000Z";
        const session: ProviderSession = {
          provider,
          ...(input.providerInstanceId !== undefined
            ? { providerInstanceId: input.providerInstanceId }
            : {}),
          ...(input.sessionIncarnationId !== undefined
            ? { sessionIncarnationId: input.sessionIncarnationId }
            : {}),
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          resumeCursor: input.resumeCursor ?? {
            opaque: `resume-${String(input.threadId)}`,
          },
          cwd: input.cwd ?? process.cwd(),
          createdAt: now,
          updatedAt: now,
        };
        sessions.set(session.threadId, session);
        return session;
      }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      });
    },
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToInteraction = vi.fn<
    NonNullable<ProviderAdapterShape<ProviderAdapterError>["respondToInteraction"]>
  >(() => Effect.void);

  const reloadSessionResources = vi.fn(
    (
      _threadId: ThreadId,
    ): Effect.Effect<
      { available: true; skills: readonly []; prompts: readonly []; commands: readonly [] },
      ProviderAdapterError
    > => Effect.succeed({ available: true, skills: [], prompts: [], commands: [] }),
  );

  const askSessionSideQuestion = vi.fn(
    (threadId: ThreadId, requestId: ProviderSessionSideQuestionRequestId, _question: string) =>
      Effect.succeed({ requestId, disposition: "answered" as const, answer: "safe answer" }),
  );

  const cancelSessionSideQuestion = vi.fn(
    (threadId: ThreadId, requestId: ProviderSessionSideQuestionRequestId) =>
      Effect.succeed({ threadId }).pipe(
        Effect.as({ requestId, disposition: "cancel-requested" as const }),
      ),
  );

  const cancelSessionAgent = vi.fn((threadId: ThreadId, agentId: RuntimeTaskId) =>
    Effect.succeed({ threadId, agentId }).pipe(
      Effect.as({ agentId, disposition: "cancel-requested" as const }),
    ),
  );

  const messageSessionAgent = vi.fn(
    (_threadId: ThreadId, agentId: RuntimeTaskId, _message: string) =>
      Effect.succeed({ agentId, disposition: "delivered" as const }),
  );

  const watchSessionAgentActivity = vi.fn((_threadId: ThreadId, agentId: RuntimeTaskId) =>
    Stream.make({
      agentId,
      revision: 1,
      entries: [{ speaker: "assistant" as const, text: "safe live activity" }],
    }),
  );

  let agentDepth = {
    maxDepth: 2,
    source: "session" as const,
    writable: true,
    settable: true,
    maxSettableDepth: 4,
  };
  const getSessionAgentDepth = vi.fn(
    (_threadId: ThreadId): Effect.Effect<typeof agentDepth, ProviderAdapterError> =>
      Effect.sync(() => agentDepth),
  );
  const setSessionAgentDepth = vi.fn(
    (
      _threadId: ThreadId,
      maxDepth: number,
    ): Effect.Effect<typeof agentDepth, ProviderAdapterError> =>
      Effect.sync(() => {
        agentDepth = { ...agentDepth, maxDepth };
        return agentDepth;
      }),
  );

  let compaction: SessionCompactionUpdatedPayload = {
    available: true,
    status: "idle" as const,
    abortable: false,
    autoCompactionEnabled: true,
    autoCompactionWritable: true,
    manualCompactionSettable: true,
    autoCompactionScope: "session-and-provider-default" as const,
  };
  const getSessionCompaction = vi.fn((_threadId: ThreadId) => Effect.sync(() => compaction));
  const compactSession = vi.fn((_threadId: ThreadId) =>
    Effect.sync(() => {
      compaction = {
        ...compaction,
        status: "starting" as const,
        abortable: true,
        manualCompactionSettable: false,
      };
      return compaction;
    }),
  );
  const abortSessionCompaction = vi.fn((_threadId: ThreadId) =>
    Effect.sync(() => {
      compaction = { ...compaction, status: "abort-requested" as const };
      return compaction;
    }),
  );
  const setSessionAutoCompaction = vi.fn(
    (input: { readonly threadId: ThreadId; readonly enabled: boolean }) =>
      Effect.sync(() => {
        compaction = { ...compaction, autoCompactionEnabled: input.enabled };
        return compaction;
      }),
  );
  const refineSessionHarness = vi.fn((_threadId: ThreadId) =>
    Effect.succeed({ appliedCount: 2, failedCount: 1, outcome: "partial" as const }),
  );

  let inputQueue: SessionInputQueueUpdatedPayload = {
    steeringCount: 0,
    followUpCount: 0,
    steeringMode: "one-at-a-time" as const,
    followUpMode: "one-at-a-time" as const,
  };
  const getSessionInputQueue = vi.fn((_threadId: ThreadId) => Effect.sync(() => inputQueue));
  const clearSessionInputQueue = vi.fn((_threadId: ThreadId) =>
    Effect.sync(() => {
      inputQueue = { ...inputQueue, steeringCount: 0, followUpCount: 0 };
      return inputQueue;
    }),
  );
  const removeOnlySessionInputQueueItem = vi.fn(
    (input: { readonly threadId: ThreadId; readonly queue: "steering" | "follow-up" }) =>
      Effect.sync(() => {
        inputQueue = {
          ...inputQueue,
          ...(input.queue === "steering" ? { steeringCount: 0 } : { followUpCount: 0 }),
        };
        return inputQueue;
      }),
  );
  const setSessionInputQueueMode = vi.fn(
    (input: {
      readonly threadId: ThreadId;
      readonly queue: "steering" | "follow-up";
      readonly mode: "all-at-once" | "one-at-a-time";
    }) =>
      Effect.sync(() => {
        inputQueue = {
          ...inputQueue,
          ...(input.queue === "steering"
            ? { steeringMode: input.mode }
            : { followUpMode: input.mode }),
        };
        return inputQueue;
      }),
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const uploadFeedback = vi.fn(
    (
      input: ProviderUploadFeedbackInput,
    ): Effect.Effect<ProviderUploadFeedbackResult, ProviderAdapterError> =>
      Effect.succeed({ feedbackId: `feedback-${input.threadId}` }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const followUp = vi.fn(
    (
      input: ProviderFollowUpInput,
    ): Effect.Effect<SessionInputQueueUpdatedPayload, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider, threadId: input.threadId }),
        );
      }
      return Effect.succeed(inputQueue);
    },
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    followUp,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    respondToInteraction,
    reloadSessionResources,
    ...(options?.supportsSideQuestions === false
      ? {}
      : { askSessionSideQuestion, cancelSessionSideQuestion }),
    cancelSessionAgent,
    messageSessionAgent,
    watchSessionAgentActivity,
    getSessionAgentDepth,
    setSessionAgentDepth,
    getSessionInputQueue,
    clearSessionInputQueue,
    removeOnlySessionInputQueueItem,
    setSessionInputQueueMode,
    getSessionCompaction,
    compactSession,
    abortSessionCompaction,
    setSessionAutoCompaction,
    refineSessionHarness,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    ...(provider === CODEX_DRIVER ? { uploadFeedback } : {}),
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const removeSession = (threadId: ThreadId): void => {
    sessions.delete(threadId);
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  const setPrepareTurnRecovery = (
    prepareTurnRecovery:
      | NonNullable<ProviderAdapterShape<ProviderAdapterError>["prepareTurnRecovery"]>
      | undefined,
  ): void => {
    const mutable = adapter as {
      prepareTurnRecovery?: NonNullable<
        ProviderAdapterShape<ProviderAdapterError>["prepareTurnRecovery"]
      >;
    };
    if (prepareTurnRecovery === undefined) delete mutable.prepareTurnRecovery;
    else mutable.prepareTurnRecovery = prepareTurnRecovery;
  };

  return {
    adapter,
    emit,
    removeSession,
    updateSession,
    setPrepareTurnRecovery,
    startSession,
    sendTurn,
    followUp,
    respondToInteraction,
    reloadSessionResources,
    askSessionSideQuestion,
    cancelSessionSideQuestion,
    cancelSessionAgent,
    messageSessionAgent,
    watchSessionAgentActivity,
    getSessionAgentDepth,
    setSessionAgentDepth,
    getSessionInputQueue,
    clearSessionInputQueue,
    removeOnlySessionInputQueueItem,
    setSessionInputQueueMode,
    getSessionCompaction,
    compactSession,
    abortSessionCompaction,
    setSessionAutoCompaction,
    refineSessionHarness,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    uploadFeedback,
    stopAll,
  };
}

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

function makeProviderServiceLayer() {
  const startReservationCounts: number[] = [];
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER, { supportsSideQuestions: false });
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
    [ProviderDriverKind.make("cursor")]: cursor.adapter,
  });

  const providerAdapterLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    registry,
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive({
        onStartReservationCountChange: (count) => startReservationCounts.push(count),
      }).pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    claude,
    cursor,
    layer,
    startReservationCounts,
  };
}

it.effect("ProviderServiceLive catches stopAll failures during shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    codex.stopAll.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "stopAll",
          detail: "simulated stopAll failure",
        }),
      ),
    );
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    );
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    yield* ProviderService.ProviderService.pipe(Effect.provide(runtimeServices));
    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);

    assert.equal(Exit.isSuccess(closeExit), true);
    assert.equal(codex.stopAll.mock.calls.length, 1);
  }),
);

it.effect("ProviderServiceLive rejects new sessions for disabled providers", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const registryBase = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [CLAUDE_AGENT_DRIVER]: claude.adapter,
    });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      ...registryBase,
      getInstanceInfo: (instanceId) =>
        instanceId === claudeAgentInstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: CLAUDE_AGENT_DRIVER,
              displayName: undefined,
              enabled: false,
              continuationIdentity: {
                driverKind: CLAUDE_AGENT_DRIVER,
                continuationKey: "claudeAgent:instance:claudeAgent",
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'claudeAgent' is disabled");
    assert.equal(claude.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive allows enabled custom instances when legacy driver is disabled",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const driverKind = CODEX_DRIVER;
      const codex = makeFakeCodexAdapter();
      const unsupported = () =>
        new ProviderUnsupportedError({
          provider: driverKind,
        });
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        getByInstance: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(codex.adapter)
            : Effect.fail(unsupported()),
        getInstanceInfo: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed({
                instanceId,
                driverKind,
                displayName: "Codex Personal",
                enabled: true,
                continuationIdentity: {
                  driverKind,
                  continuationKey: "codex:/Users/example/.codex",
                },
              })
            : Effect.fail(unsupported()),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([driverKind] as const),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      };
      const providerAdapterLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        registry,
      );
      const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest({
        providers: {
          codex: {
            enabled: false,
          },
        },
      });
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-enabled-custom"), {
          provider: driverKind,
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-enabled-custom"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.providerInstanceId, instanceId);
      assert.equal(codex.startSession.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive rejects new sessions for disabled custom instances", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const driverKind = ProviderDriverKind.make("codex");
    const codex = makeFakeCodexAdapter();
    const unsupported = () =>
      new ProviderUnsupportedError({
        provider: ProviderDriverKind.make("codex"),
      });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      getByInstance: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(codex.adapter)
          : Effect.fail(unsupported()),
      getInstanceInfo: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed({
              instanceId,
              driverKind,
              displayName: "Codex Personal",
              enabled: false,
              continuationIdentity: {
                driverKind,
                continuationKey: "codex:/Users/example/.codex",
              },
            })
          : Effect.fail(unsupported()),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CODEX_DRIVER] as const),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled-instance"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-disabled-instance"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'codex_personal' is disabled");
    assert.equal(codex.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const routing = makeProviderServiceLayer();

it.effect(
  "ProviderServiceLive uploads feedback through the adapter that recovered the session",
  () =>
    Effect.gen(function* () {
      const original = makeFakeCodexAdapter();
      const replacement = makeFakeCodexAdapter();
      const baseRegistry = makeAdapterRegistryMock({ [CODEX_DRIVER]: original.adapter });
      let swapAfterFirstLookup = false;
      let feedbackLookupCount = 0;
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        ...baseRegistry,
        getByInstance: (instanceId) => {
          if (instanceId !== codexInstanceId) {
            return baseRegistry.getByInstance(instanceId);
          }
          const useReplacement = swapAfterFirstLookup && feedbackLookupCount++ > 0;
          return Effect.succeed(useReplacement ? replacement.adapter : original.adapter);
        },
      };
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("thread-feedback-adapter-replacement");
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        });
        yield* original.stopSession(threadId);
        original.uploadFeedback.mockClear();
        replacement.uploadFeedback.mockClear();
        swapAfterFirstLookup = true;

        const result = yield* provider.uploadFeedback({ threadId });

        assert.deepStrictEqual(result, { feedbackId: `feedback-${threadId}` });
        assert.strictEqual(original.uploadFeedback.mock.calls.length, 0);
        assert.deepStrictEqual(replacement.uploadFeedback.mock.calls, [[{ threadId }]]);
      }).pipe(Effect.provide(providerLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive writes canonical events to the emitting thread segment", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const canonicalEvents: ProviderRuntimeEvent[] = [];
    const canonicalThreadIds: Array<string | null> = [];
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive({
      canonicalEventLogger: {
        filePath: "memory://provider-canonical-events",
        write: (event, threadId) => {
          canonicalEvents.push(event as ProviderRuntimeEvent);
          canonicalThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-canonical-thread-segment");
      const session = yield* provider.startSession(threadId, {
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        cwd: "/tmp/provider-canonical-thread-segment",
        runtimeMode: "full-access",
      });
      yield* advanceTestClock(10);
      codex.emit({
        eventId: asEventId("evt-canonical-thread-segment"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        sessionIncarnationId: session.sessionIncarnationId,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
      yield* advanceTestClock(20);
    }).pipe(Effect.provide(providerLayer));

    assert.equal(canonicalEvents.length, 1);
    assert.equal(canonicalEvents[0]?.threadId, "thread-canonical-thread-segment");
    assert.deepEqual(canonicalThreadIds, ["thread-canonical-thread-segment"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-service-"));
    const dbPath = NodePath.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: ThreadId.make("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* ProviderService.ProviderService.pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({
        threadId: asThreadId("thread-stale"),
      });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-restart-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: firstCodex.adapter,
      });

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: "2026-01-01T00:00:01.000Z",
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({
          threadId: startedSession.threadId,
        });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: secondCodex.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive fences starts and inventories exact instance quiescence", () => {
  const codex = makeFakeCodexAdapter();
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER);
  const registry = makeAdapterRegistryMock({
    [CODEX_DRIVER]: codex.adapter,
    [CURSOR_DRIVER]: cursor.adapter,
  });
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
  const providerLayer = Layer.merge(
    makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    ),
    directoryLayer,
  );

  return Effect.gen(function* () {
    const provider = yield* ProviderService.ProviderService;
    const activeThread = asThreadId("thread-maintenance-active");
    yield* provider.startSession(activeThread, {
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
      threadId: activeThread,
      cwd: "/tmp/project-maintenance-active",
      runtimeMode: "full-access",
    });
    assert.deepInclude(yield* provider.reserveProviderMaintenance!(codexInstanceId), {
      status: "busy",
    });

    const quiescentInstanceId = ProviderInstanceId.make("cursor");
    const reserved = yield* provider.reserveProviderMaintenance!(quiescentInstanceId);
    assert.equal(reserved.status, "reserved");
    if (reserved.status !== "reserved") return;
    const fencedThread = asThreadId("thread-maintenance-fenced");
    const fencedError = yield* provider
      .startSession(fencedThread, {
        provider: CURSOR_DRIVER,
        providerInstanceId: quiescentInstanceId,
        threadId: fencedThread,
        cwd: "/tmp/project-maintenance-fenced",
        runtimeMode: "full-access",
      })
      .pipe(Effect.flip);
    assert.instanceOf(fencedError, ProviderValidationError);
    assert.include(fencedError.message, "fenced for scheduled host maintenance");

    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    const recoveryThread = asThreadId("thread-maintenance-recovery-fenced");
    yield* directory.upsert({
      threadId: recoveryThread,
      provider: CURSOR_DRIVER,
      providerInstanceId: quiescentInstanceId,
      runtimeMode: "full-access",
    });
    cursor.startSession.mockClear();
    const recoveryError = yield* provider
      .sendTurn({ threadId: recoveryThread, input: "must not recover", attachments: [] })
      .pipe(Effect.flip);
    assert.instanceOf(recoveryError, ProviderValidationError);
    assert.include(recoveryError.message, "fenced for scheduled host maintenance");
    assert.equal(cursor.startSession.mock.calls.length, 0);

    yield* provider.releaseProviderMaintenance!(reserved.reservation);
    yield* provider.startSession(fencedThread, {
      provider: CURSOR_DRIVER,
      providerInstanceId: quiescentInstanceId,
      threadId: fencedThread,
      cwd: "/tmp/project-maintenance-fenced",
      runtimeMode: "full-access",
    });
    yield* provider.stopSession({ threadId: fencedThread });
    yield* provider.stopSession({ threadId: activeThread });
  }).pipe(Effect.provide(Layer.merge(providerLayer, NodeServices.layer)));
});

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("reclaims start reservations after long historical-thread churn", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      routing.startReservationCounts.length = 0;

      for (let index = 0; index < 200; index += 1) {
        const threadId = asThreadId(`thread-reservation-churn-${index}`);
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        });
        yield* provider.stopSession({ threadId });
      }

      assert.equal(Math.max(...routing.startReservationCounts), 1);
      assert.equal(routing.startReservationCounts.at(-1), 0);
    }),
  );

  it.effect("routes side questions once without recovering inactive sessions", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-side-question");
      const requestId = ProviderSessionSideQuestionRequestId.make("side-question-1");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "approval-required",
      });
      routing.codex.askSessionSideQuestion.mockClear();
      routing.codex.cancelSessionSideQuestion.mockClear();

      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const question = "private question";
      const answer = yield* provider
        .askSessionSideQuestion({ threadId, requestId, question })
        .pipe(Effect.withTracer(tracer));
      assert.deepEqual(answer, {
        requestId,
        disposition: "answered",
        answer: "safe answer",
      });
      assert.deepEqual(routing.codex.askSessionSideQuestion.mock.calls, [
        [threadId, requestId, question],
      ]);
      const serializedSpanAttributes = spans
        .flatMap((span) =>
          Array.from(span.attributes.entries()).flatMap(([key, value]) => [key, String(value)]),
        )
        .join("\n");
      assert.notInclude(serializedSpanAttributes, question);
      assert.notInclude(serializedSpanAttributes, "safe answer");
      assert.notInclude(serializedSpanAttributes, requestId);

      const cancellation = yield* provider.cancelSessionSideQuestion({ threadId, requestId });
      assert.deepEqual(cancellation, { requestId, disposition: "cancel-requested" });
      assert.deepEqual(routing.codex.cancelSessionSideQuestion.mock.calls, [[threadId, requestId]]);

      yield* provider.stopSession({ threadId });
      routing.codex.startSession.mockClear();
      routing.codex.askSessionSideQuestion.mockClear();
      const inactiveError = yield* provider
        .askSessionSideQuestion({ threadId, requestId, question: "private question" })
        .pipe(Effect.flip);
      assert.instanceOf(inactiveError, ProviderValidationError);
      routing.codex.cancelSessionSideQuestion.mockClear();
      const inactiveCancelError = yield* provider
        .cancelSessionSideQuestion({ threadId, requestId })
        .pipe(Effect.flip);
      assert.instanceOf(inactiveCancelError, ProviderValidationError);
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.equal(routing.codex.askSessionSideQuestion.mock.calls.length, 0);
      assert.equal(routing.codex.cancelSessionSideQuestion.mock.calls.length, 0);
    }),
  );

  it.effect("fails side questions on unsupported adapters", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-side-question-unsupported");
      const requestId = ProviderSessionSideQuestionRequestId.make("side-question-unsupported");
      yield* provider.startSession(threadId, {
        provider: CURSOR_DRIVER,
        providerInstanceId: ProviderInstanceId.make("cursor"),
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "approval-required",
      });

      const error = yield* provider
        .askSessionSideQuestion({ threadId, requestId, question: "private question" })
        .pipe(Effect.flip);
      assert.instanceOf(error, ProviderUnsupportedError);
      assert.equal(routing.cursor.askSessionSideQuestion.mock.calls.length, 0);
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("recovers exact running admission lineage from per-instance inventory", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-inventory-admission-lineage");
      const requestId = CommandId.make("cmd-inventory-admission-lineage");
      const turnId = asTurnId("turn-inventory-admission-lineage");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-inventory-admission-lineage",
        runtimeMode: "full-access",
      });
      assert.isDefined(session.sessionIncarnationId);
      yield* provider.sendTurn({
        threadId,
        input: "persist exact admission",
        attachments: [],
        admissionRequestId: requestId,
        sessionIncarnationId: session.sessionIncarnationId,
      });
      routing.codex.updateSession(threadId, (current) => ({
        ...current,
        status: "running",
        activeTurnId: turnId,
      }));

      const sessions = yield* provider.listSessionsForInstance!(codexInstanceId);
      const inventoried = sessions.find((candidate) => candidate.threadId === threadId);
      assert.equal(inventoried?.status, "running");
      assert.equal(inventoried?.activeTurnId, turnId);
      assert.equal(inventoried?.activeTurnRequestId, requestId);
      assert.equal(inventoried?.sessionIncarnationId, session.sessionIncarnationId);
      yield* provider.stopSession({ threadId });
      routing.codex.sendTurn.mockClear();
    }),
  );

  it.effect("rejects a model selection from another instance before adapter dispatch", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-model-instance-mismatch");
      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      routing.codex.sendTurn.mockClear();
      routing.codex.startSession.mockClear();
      routing.codex.removeSession(threadId);

      const error = yield* provider
        .sendTurn({
          threadId,
          input: "must not dispatch",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-4-6",
          },
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ProviderValidationError);
      assert.match(error.issue, /model selection belongs to 'claudeAgent'/);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      yield* provider.stopSession({ threadId });
    }),
  );

  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.threadId, undefined]]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.respondToInteraction({
        threadId: session.threadId,
        requestId: SessionInteractionRequestId.make("interaction-1"),
        response: { kind: "confirmed", confirmed: true },
      });
      assert.deepEqual(routing.codex.respondToInteraction.mock.calls, [
        [
          session.threadId,
          SessionInteractionRequestId.make("interaction-1"),
          { kind: "confirmed", confirmed: true },
        ],
      ]);

      const resources = yield* provider.reloadSessionResources({ threadId: session.threadId });
      assert.deepEqual(resources, { available: true, skills: [], prompts: [], commands: [] });
      assert.deepEqual(routing.codex.reloadSessionResources.mock.calls, [[session.threadId]]);

      const cancelled = yield* provider.cancelSessionAgent({
        threadId: session.threadId,
        agentId: RuntimeTaskId.make("agent-1"),
      });
      assert.deepEqual(cancelled, {
        agentId: RuntimeTaskId.make("agent-1"),
        disposition: "cancel-requested",
      });
      assert.deepEqual(routing.codex.cancelSessionAgent.mock.calls, [
        [session.threadId, RuntimeTaskId.make("agent-1")],
      ]);

      const messaged = yield* provider.messageSessionAgent({
        threadId: session.threadId,
        agentId: RuntimeTaskId.make("agent-1"),
        message: "Check the failing test.",
      });
      assert.deepEqual(messaged, {
        agentId: RuntimeTaskId.make("agent-1"),
        disposition: "delivered",
      });
      assert.deepEqual(routing.codex.messageSessionAgent.mock.calls, [
        [session.threadId, RuntimeTaskId.make("agent-1"), "Check the failing test."],
      ]);

      const activity = Array.from(
        yield* Stream.runCollect(
          provider.watchSessionAgentActivity({
            threadId: session.threadId,
            agentId: RuntimeTaskId.make("agent-1"),
          }),
        ),
      );
      assert.deepEqual(activity, [
        {
          agentId: RuntimeTaskId.make("agent-1"),
          revision: 1,
          entries: [{ speaker: "assistant", text: "safe live activity" }],
        },
      ]);
      assert.deepEqual(routing.codex.watchSessionAgentActivity.mock.calls, [
        [session.threadId, RuntimeTaskId.make("agent-1")],
      ]);

      const invalidDepth = yield* provider
        .setSessionAgentDepth({ threadId: session.threadId, maxDepth: 5 })
        .pipe(Effect.flip);
      assert.equal(invalidDepth._tag, "ProviderValidationError");
      assert.deepEqual(routing.codex.setSessionAgentDepth.mock.calls, []);

      const depth = yield* provider.getSessionAgentDepth({ threadId: session.threadId });
      const updatedDepth = yield* provider.setSessionAgentDepth({
        threadId: session.threadId,
        maxDepth: 3,
      });
      assert.equal(depth.maxDepth, 2);
      assert.equal(updatedDepth.maxDepth, 3);
      assert.deepEqual(routing.codex.getSessionAgentDepth.mock.calls, [[session.threadId]]);
      assert.deepEqual(routing.codex.setSessionAgentDepth.mock.calls, [[session.threadId, 3]]);

      const queue = yield* provider.getSessionInputQueue({ threadId: session.threadId });
      const updatedQueue = yield* provider.setSessionInputQueueMode({
        threadId: session.threadId,
        queue: "steering",
        mode: "all-at-once",
      });
      assert.equal(queue.steeringMode, "one-at-a-time");
      assert.equal(updatedQueue.steeringMode, "all-at-once");
      assert.deepEqual(routing.codex.getSessionInputQueue.mock.calls, [[session.threadId]]);
      assert.deepEqual(routing.codex.setSessionInputQueueMode.mock.calls, [
        [
          {
            threadId: session.threadId,
            queue: "steering",
            mode: "all-at-once",
          },
        ],
      ]);

      const compactionState = yield* provider.getSessionCompaction({
        threadId: session.threadId,
      });
      const compacting = yield* provider.compactSession({ threadId: session.threadId });
      const aborting = yield* provider.abortSessionCompaction({ threadId: session.threadId });
      const autoDisabled = yield* provider.setSessionAutoCompaction({
        threadId: session.threadId,
        enabled: false,
      });
      assert.equal(compactionState.status, "idle");
      assert.equal(compacting.status, "starting");
      assert.equal(aborting.status, "abort-requested");
      assert.equal(autoDisabled.autoCompactionEnabled, false);
      assert.deepEqual(routing.codex.getSessionCompaction.mock.calls, [[session.threadId]]);
      assert.deepEqual(routing.codex.compactSession.mock.calls, [[session.threadId]]);
      assert.deepEqual(routing.codex.abortSessionCompaction.mock.calls, [[session.threadId]]);
      assert.deepEqual(routing.codex.setSessionAutoCompaction.mock.calls, [
        [{ threadId: session.threadId, enabled: false }],
      ]);
      assert.deepEqual(yield* provider.refineSessionHarness({ threadId: session.threadId }), {
        appliedCount: 2,
        failedCount: 1,
        outcome: "partial",
      });
      assert.deepEqual(routing.codex.refineSessionHarness.mock.calls, [[session.threadId]]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      yield* provider.stopSession({ threadId: session.threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      const reloadError = yield* provider
        .reloadSessionResources({ threadId: session.threadId })
        .pipe(Effect.flip);
      assert.equal(reloadError._tag, "ProviderValidationError");
      const inactiveDepthError = yield* provider
        .setSessionAgentDepth({ threadId: session.threadId, maxDepth: 1 })
        .pipe(Effect.flip);
      assert.equal(inactiveDepthError._tag, "ProviderValidationError");
      if (inactiveDepthError._tag === "ProviderValidationError") {
        assert.equal(inactiveDepthError.reason, undefined);
      }
      assert.equal(routing.codex.startSession.mock.calls.length, 0);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "after-stop",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, session.resumeCursor);
        assert.equal(startPayload.threadId, session.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("routes feedback to the Codex adapter and returns its feedback ID", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-feedback-route");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.uploadFeedback.mockClear();

      const result = yield* provider.uploadFeedback({
        threadId,
        reason: "The agent stopped early.",
      });

      assert.deepStrictEqual(result, { feedbackId: `feedback-${threadId}` });
      assert.deepStrictEqual(routing.codex.uploadFeedback.mock.calls, [
        [{ threadId, reason: "The agent stopped early." }],
      ]);
    }),
  );

  it.effect("recovers a stopped Codex session before uploading feedback", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-feedback-recover");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/feedback-project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(threadId);
      routing.codex.startSession.mockClear();
      routing.codex.uploadFeedback.mockClear();

      const result = yield* provider.uploadFeedback({ threadId });

      assert.deepStrictEqual(result, { feedbackId: `feedback-${threadId}` });
      assert.strictEqual(routing.codex.startSession.mock.calls.length, 1);
      assert.deepStrictEqual(routing.codex.uploadFeedback.mock.calls, [[{ threadId }]]);
    }),
  );

  it.effect("rejects feedback for providers that do not support uploads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-feedback-claude");
      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const error = yield* provider.uploadFeedback({ threadId }).pipe(Effect.flip);

      assert.instanceOf(error, ProviderValidationError);
      assert.include(error.issue, "does not support feedback uploads");
      routing.claude.startSession.mockClear();
    }),
  );

  it.effect("does not restart an unsupported provider before rejecting feedback", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-feedback-unsupported-stopped");
      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* routing.claude.stopSession(threadId);
      routing.claude.startSession.mockClear();

      const error = yield* provider.uploadFeedback({ threadId }).pipe(Effect.flip);

      assert.instanceOf(error, ProviderValidationError);
      assert.include(error.issue, "does not support feedback uploads");
      assert.strictEqual(routing.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("appends attachment file paths to the turn input text", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-attach"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-attach"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const attachment = {
        type: "image" as const,
        id: "thread-attach-12345678-1234-1234-1234-123456789abc",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 123,
      };

      routing.codex.sendTurn.mockClear();
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "use this screenshot",
        attachments: [attachment],
      });

      const turnInput = routing.codex.sendTurn.mock.calls[0]?.[0] as ProviderSendTurnInput;
      assert.equal(typeof turnInput.input, "string");
      const turnText = turnInput.input ?? "";
      assert.equal(turnText.startsWith("use this screenshot"), true);
      assert.include(turnText, '[Attached image "screenshot.png" is saved at: ');
      assert.equal(turnText.endsWith(`${attachment.id}.png]`), true);

      // An attachment-only turn stays valid and the injected line becomes the
      // whole input text, so the agent still learns the path.
      routing.codex.sendTurn.mockClear();
      yield* provider.sendTurn({
        threadId: session.threadId,
        attachments: [attachment],
      });
      const imageOnlyInput = routing.codex.sendTurn.mock.calls[0]?.[0] as ProviderSendTurnInput;
      assert.equal(imageOnlyInput.input?.startsWith('[Attached image "screenshot.png"'), true);

      const fileAttachment = {
        type: "file" as const,
        id: "thread-attach-12345678-1234-1234-1234-123456789abc-pdf",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 456,
      };

      routing.codex.sendTurn.mockClear();
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "summarize the report",
        attachments: [attachment, fileAttachment],
      });
      const mixedInput = routing.codex.sendTurn.mock.calls[0]?.[0] as ProviderSendTurnInput;
      assert.include(mixedInput.input ?? "", '[Attached file "report.pdf" is saved at: ');
      assert.include(mixedInput.input ?? "", `${fileAttachment.id}.pdf]`);
      // Every attachment reaches the adapter; each adapter decides what its
      // provider ingests natively.
      assert.deepEqual(mixedInput.attachments, [attachment, fileAttachment]);

      routing.codex.sendTurn.mockClear();
      yield* provider.sendTurn({ threadId: session.threadId, attachments: [fileAttachment] });
      const fileOnlyInput = routing.codex.sendTurn.mock.calls[0]?.[0] as ProviderSendTurnInput;
      assert.include(fileOnlyInput.input ?? "", '[Attached file "report.pdf" is saved at: ');
      assert.deepEqual(fileOnlyInput.attachments, [fileAttachment]);

      // Follow-ups need the same path lines. Every adapter except OpenCode skips
      // non-image attachments, so without this a file attached to a queued
      // follow-up reaches the agent as nothing at all.
      yield* provider.followUp({
        threadId: session.threadId,
        input: "and this one",
        attachments: [fileAttachment],
      });
      const followUpInput = routing.codex.followUp.mock.calls[0]?.[0] as ProviderFollowUpInput;
      assert.include(followUpInput.input ?? "", "and this one");
      assert.include(followUpInput.input ?? "", '[Attached file "report.pdf" is saved at: ');
      assert.include(followUpInput.input ?? "", `${fileAttachment.id}.pdf]`);
      assert.deepEqual(followUpInput.attachments, [fileAttachment]);

      yield* provider.stopSession({ threadId: session.threadId });
    }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("preserves the persisted binding when stopping a session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const initial = yield* provider.startSession(asThreadId("thread-reap-preserve"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-reap-preserve"),
        cwd: "/tmp/project-reap-preserve",
        runtimeMode: "full-access",
      });

      yield* provider.stopSession({ threadId: initial.threadId });

      const persistedAfterStop = yield* runtimeRepository.getByThreadId({
        threadId: initial.threadId,
      });
      assert.equal(Option.isSome(persistedAfterStop), true);
      if (Option.isSome(persistedAfterStop)) {
        assert.equal(persistedAfterStop.value.status, "stopped");
        assert.deepEqual(persistedAfterStop.value.resumeCursor, initial.resumeCursor);
      }

      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume after reap",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-reap-preserve");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("routes explicit claudeAgent provider session starts to the claude adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-claude"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude"),
        cwd: "/tmp/project-claude",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "claudeAgent");
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const startInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as {
          provider?: string;
          providerInstanceId?: ProviderInstanceId;
          cwd?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.providerInstanceId, claudeAgentInstanceId);
        assert.equal(startPayload.cwd, "/tmp/project-claude");
      }
    }),
  );

  it.effect("dies when an active session conflicts with its persisted binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-binding-mismatch");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-binding-mismatch",
        runtimeMode: "full-access",
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        runtimeMode: "full-access",
      });

      const exit = yield* Effect.exit(provider.listSessions());
      assert.equal(Exit.hasDies(exit), true);
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("stops stale sessions in other providers after a successful replacement start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-provider-replacement");

      const codexSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockClear();
      routing.claude.stopSession.mockClear();

      const claudeSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      assert.equal(codexSession.provider, "codex");
      assert.equal(claudeSession.provider, "claudeAgent");
      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(routing.claude.stopSession.mock.calls.length, 0);

      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ["claudeAgent"],
      );
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
          sessionIncarnationId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
        assert.equal(typeof startPayload.sessionIncarnationId, "string");
        assert.notEqual(startPayload.sessionIncarnationId, initial.sessionIncarnationId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale claudeAgent sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-claude-send-turn"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude-send-turn"),
        cwd: "/tmp/project-claude-send-turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      yield* routing.claude.stopAll();
      routing.claude.startSession.mockClear();
      routing.claude.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with claude",
        attachments: [],
      });

      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-send-turn");
        assert.deepEqual(
          startPayload.modelSelection,
          createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
            { id: "effort", value: "max" },
          ]),
        );
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      yield* routing.claude.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const threadId = asThreadId("thread-runtime-status");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, session.cwd);
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("persists turn.started before a pending provider send completes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sendStarted = yield* Deferred.make<void>();
      const releaseSend = yield* Deferred.make<void>();
      routing.codex.sendTurn.mockImplementationOnce((input) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(sendStarted, undefined);
          yield* Deferred.await(releaseSend);
          return {
            threadId: input.threadId,
            turnId: TurnId.make(`turn-${String(input.threadId)}`),
          };
        }),
      );

      const threadId = asThreadId("thread-started-event-directory");
      const session = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const admissionRequestId = CommandId.make("request-started-event-directory");
      const turnId = TurnId.make("turn-started-event-directory");
      const eventId = asEventId("evt-started-event-directory");
      const published = yield* provider.streamEvents.pipe(
        Stream.filter((event) => event.eventId === eventId),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const send = yield* provider
        .sendTurn({
          threadId,
          input: "hold until durable",
          attachments: [],
          admissionRequestId,
          sessionIncarnationId: session.sessionIncarnationId,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(sendStarted);

      routing.codex.emit({
        type: "turn.started",
        eventId,
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId,
        turnId,
        admissionRequestId,
        sessionIncarnationId: session.sessionIncarnationId,
        payload: {},
      });
      yield* Fiber.join(published);

      const persisted = Option.getOrThrow(yield* runtimeRepository.getByThreadId({ threadId }));
      assert.equal(persisted.status, "running");
      assert.deepEqual(persisted.runtimePayload, {
        activeTurnId: turnId,
        activeTurnRequestId: admissionRequestId,
        admissionRequestId,
        cwd: process.cwd(),
        lastError: null,
        lastRuntimeEvent: "turn.started",
        lastRuntimeEventAt: "2026-01-01T00:00:00.000Z",
        model: null,
        sessionIncarnationId: session.sessionIncarnationId,
      });

      yield* Deferred.succeed(releaseSend, undefined);
      yield* Fiber.join(send);
    }),
  );

  it.effect("does not persist running after a concurrent send is interrupted", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sendStarted = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      routing.codex.sendTurn.mockImplementationOnce(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(sendStarted, undefined);
          yield* Deferred.await(interrupted);
          return yield* Effect.interrupt;
        }),
      );
      routing.codex.interruptTurn.mockImplementationOnce(() =>
        Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
      );

      const threadId = asThreadId("thread-interrupted-send-directory");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const sendExitFiber = yield* provider
        .sendTurn({
          threadId: session.threadId,
          input: "hold this prompt",
          attachments: [],
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(sendStarted);
      yield* provider.interruptTurn({ threadId: session.threadId });
      const sendExit = yield* Fiber.join(sendExitFiber);

      assert.equal(Exit.isFailure(sendExit), true);
      if (Exit.isFailure(sendExit)) {
        assert.equal(Cause.hasInterruptsOnly(sendExit.cause), true);
      }
      const persisted = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        // The directory folds both adapter "ready" and "running" into its
        // runtime "running" state. The payload proves sendTurn did not upsert.
        assert.equal(persisted.value.status, "running");
        const payload = persisted.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            activeTurnId?: string | null;
            lastRuntimeEvent?: string | null;
          };
          assert.equal(runtimePayload.activeTurnId ?? null, null);
          assert.notEqual(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-start-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
      });
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-claude-start"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-claude-start"),
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondClaude.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: initial.threadId,
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reuses persisted cwd when startSession resumes a claude session without cwd input",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-provider-service-cwd-"),
        );
        const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
        const persistenceLayer = makeSqlitePersistenceLive(dbPath);
        const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
          Layer.provide(persistenceLayer),
        );

        const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const firstRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
        });
        const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const firstProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
          ),
          Layer.provide(firstDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(serverConfigTestLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        const initial = yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          return yield* provider.startSession(asThreadId("thread-claude-cwd"), {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: asThreadId("thread-claude-cwd"),
            cwd: "/tmp/project-claude-cwd",
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(firstProviderLayer));

        const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const secondRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
        });
        const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const secondProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
          ),
          Layer.provide(secondDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(serverConfigTestLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        secondClaude.startSession.mockClear();

        yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          yield* provider.startSession(initial.threadId, {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: initial.threadId,
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(secondProviderLayer));

        assert.equal(secondClaude.startSession.mock.calls.length, 1);
        const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
        assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
        if (resumedStartInput && typeof resumedStartInput === "object") {
          const startPayload = resumedStartInput as {
            provider?: string;
            cwd?: string;
            resumeCursor?: unknown;
            threadId?: string;
          };
          assert.equal(startPayload.provider, "claudeAgent");
          assert.equal(startPayload.cwd, "/tmp/project-claude-cwd");
          assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
          assert.equal(startPayload.threadId, initial.threadId);
        }

        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("serializes same-thread starts and quarantines the superseded result", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-concurrent-start");
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<ProviderSession>();
      let firstInput: ProviderSessionStartInput | undefined;
      fanout.codex.startSession.mockImplementationOnce((input) => {
        firstInput = input;
        return Deferred.succeed(firstEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
        );
      });

      const firstFiber = yield* provider
        .startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);
      const secondFiber = yield* provider
        .startSession(threadId, {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      assert.isDefined(firstInput);
      const now = "2026-01-01T00:00:00.000Z";
      yield* Deferred.succeed(releaseFirst, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        sessionIncarnationId: firstInput?.sessionIncarnationId,
        status: "ready",
        runtimeMode: "full-access",
        threadId,
        cwd: process.cwd(),
        createdAt: now,
        updatedAt: now,
      });

      const firstExit = yield* Fiber.await(firstFiber);
      const second = yield* Fiber.join(secondFiber);
      assert.equal(Exit.isFailure(firstExit), true);
      assert.equal(second.provider, CLAUDE_AGENT_DRIVER);
      assert.equal(fanout.codex.stopSession.mock.calls.length, 1);
      assert.equal(fanout.claude.startSession.mock.calls.length, 1);
      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        [CLAUDE_AGENT_DRIVER],
      );
    }),
  );

  it.effect("cancels a first slow start before it can persist or send", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-stop-slow-first-start");
      const stopCallsBefore = fanout.codex.stopSession.mock.calls.length;
      const startEntered = yield* Deferred.make<ProviderSessionStartInput>();
      const releaseStart = yield* Deferred.make<ProviderSession>();
      fanout.codex.startSession.mockImplementationOnce((input) =>
        Deferred.succeed(startEntered, input).pipe(Effect.andThen(Deferred.await(releaseStart))),
      );

      const startFiber = yield* provider
        .startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      const startInput = yield* Deferred.await(startEntered);

      // No binding exists yet. Stop must still invalidate this exact start and
      // return without waiting for adapter creation to finish.
      yield* provider.stopSession({ threadId });
      const now = "2026-01-01T00:00:00.000Z";
      yield* Deferred.succeed(releaseStart, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        sessionIncarnationId: startInput.sessionIncarnationId,
        status: "ready",
        runtimeMode: "full-access",
        threadId,
        cwd: process.cwd(),
        createdAt: now,
        updatedAt: now,
      });

      const startExit = yield* Fiber.await(startFiber);
      assert.equal(Exit.isFailure(startExit), true);
      assert.equal(fanout.codex.stopSession.mock.calls.length, stopCallsBefore + 1);
      assert.equal(Option.isNone(yield* directory.getBinding(threadId)), true);
      assert.deepEqual(
        (yield* provider.listSessions()).filter((session) => session.threadId === threadId),
        [],
      );
    }),
  );

  it.effect("keeps Stop authoritative while an account transition is starting", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-stop-slow-transition");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const codexStopCallsBefore = fanout.codex.stopSession.mock.calls.length;
      const claudeStopCallsBefore = fanout.claude.stopSession.mock.calls.length;

      const transitionEntered = yield* Deferred.make<ProviderSessionStartInput>();
      const releaseTransition = yield* Deferred.make<ProviderSession>();
      fanout.claude.startSession.mockImplementationOnce((input) =>
        Deferred.succeed(transitionEntered, input).pipe(
          Effect.andThen(Deferred.await(releaseTransition)),
        ),
      );
      const transitionFiber = yield* provider
        .startSession(threadId, {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      const transitionInput = yield* Deferred.await(transitionEntered);

      yield* provider.stopSession({ threadId });
      const now = "2026-01-01T00:00:00.000Z";
      yield* Deferred.succeed(releaseTransition, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        sessionIncarnationId: transitionInput.sessionIncarnationId,
        status: "ready",
        runtimeMode: "full-access",
        threadId,
        cwd: process.cwd(),
        createdAt: now,
        updatedAt: now,
      });

      assert.equal(Exit.isFailure(yield* Fiber.await(transitionFiber)), true);
      assert.equal(fanout.codex.stopSession.mock.calls.length, codexStopCallsBefore + 1);
      assert.equal(fanout.claude.stopSession.mock.calls.length, claudeStopCallsBefore + 1);
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(binding?.providerInstanceId, codexInstanceId);
      assert.equal(binding?.status, "stopped");
      assert.deepEqual(
        (yield* provider.listSessions()).filter((session) => session.threadId === threadId),
        [],
      );
    }),
  );

  it.effect("retains a live same-incarnation replacement after an old session exit", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-live-same-incarnation-exit");
      const session = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const received = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 2).pipe(
        Stream.runForEach((event) => Ref.update(received, (events) => [...events, event])),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      fanout.codex.emit({
        type: "session.exited",
        eventId: asEventId("evt-live-same-incarnation-old-exit"),
        provider: CODEX_DRIVER,
        threadId,
        sessionIncarnationId: session.sessionIncarnationId,
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { exitKind: "graceful" },
      });
      fanout.codex.emit({
        type: "content.delta",
        eventId: asEventId("evt-live-same-incarnation-current-output"),
        provider: CODEX_DRIVER,
        threadId,
        sessionIncarnationId: session.sessionIncarnationId,
        createdAt: "2026-01-01T00:00:01.000Z",
        delta: "current",
      });
      yield* Fiber.join(consumer);

      assert.deepEqual(
        (yield* Ref.get(received)).map((event) => event.eventId),
        [
          asEventId("evt-live-same-incarnation-old-exit"),
          asEventId("evt-live-same-incarnation-current-output"),
        ],
      );
    }),
  );

  it.effect("keeps a logical incarnation current across a recovery attachment swap", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-recovery-attachment-swap");
      const session = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const admissionRequestId = CommandId.make("cmd-recovery-attachment-swap");
      fanout.codex.setPrepareTurnRecovery((input) =>
        Effect.gen(function* () {
          fanout.codex.removeSession(threadId);
          fanout.codex.emit({
            type: "session.exited",
            eventId: asEventId("evt-recovery-attachment-old-exit"),
            provider: CODEX_DRIVER,
            threadId,
            sessionIncarnationId: session.sessionIncarnationId,
            createdAt: "2026-01-01T00:00:00.000Z",
            payload: { exitKind: "graceful" },
          });
          yield* Effect.yieldNow;
          yield* fanout.codex.startSession({
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            threadId,
            runtimeMode: session.runtimeMode,
            ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
            sessionIncarnationId: session.sessionIncarnationId,
          });
          fanout.codex.emit({
            type: "turn.started",
            eventId: asEventId("evt-recovery-attachment-current-turn"),
            provider: CODEX_DRIVER,
            threadId,
            turnId: asTurnId("turn-recovery-attachment-swap"),
            admissionRequestId: input.admissionRequestId,
            sessionIncarnationId: session.sessionIncarnationId,
            createdAt: "2026-01-01T00:00:01.000Z",
            payload: {},
          });
        }),
      );
      const received = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 2).pipe(
        Stream.runForEach((event) => Ref.update(received, (events) => [...events, event])),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* provider.sendTurn({
        threadId,
        input: "continue after the exact attachment swap",
        admissionRequestId,
        sessionIncarnationId: session.sessionIncarnationId,
      });
      yield* Fiber.join(consumer);

      assert.deepEqual(
        (yield* Ref.get(received)).map((event) => event.eventId),
        [
          asEventId("evt-recovery-attachment-old-exit"),
          asEventId("evt-recovery-attachment-current-turn"),
        ],
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          fanout.codex.setPrepareTurnRecovery(undefined);
        }),
      ),
    ),
  );

  it.effect("retains a stopping incarnation until its delayed exit is ingested", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-delayed-stop-exit");
      const session = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const releaseExit = yield* Deferred.make<void>();
      fanout.codex.stopSession.mockImplementationOnce((stoppedThreadId) =>
        Effect.gen(function* () {
          fanout.codex.removeSession(stoppedThreadId);
          yield* Deferred.await(releaseExit).pipe(
            Effect.andThen(
              Effect.sync(() =>
                fanout.codex.emit({
                  type: "session.exited",
                  eventId: asEventId("evt-delayed-stop-exit"),
                  provider: CODEX_DRIVER,
                  threadId,
                  sessionIncarnationId: session.sessionIncarnationId,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  payload: { exitKind: "graceful" },
                }),
              ),
            ),
            Effect.forkChild,
          );
        }),
      );
      const received = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach((event) => Ref.update(received, (events) => [...events, event])),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* provider.stopSession({ threadId });
      yield* Deferred.succeed(releaseExit, undefined);
      yield* Fiber.join(consumer);

      assert.deepEqual(
        (yield* Ref.get(received)).map((event) => event.eventId),
        [asEventId("evt-delayed-stop-exit")],
      );
    }),
  );

  it.effect("clears a destroyed incarnation when its same-adapter replacement fails", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-destroyed-replacement");
      const oldSession = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      fanout.codex.startSession.mockImplementationOnce(() =>
        Effect.sync(() => fanout.codex.removeSession(threadId)).pipe(
          Effect.andThen(
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: CODEX_DRIVER,
                method: "startSession",
                detail: "replacement failed after destroying the old session",
              }),
            ),
          ),
        ),
      );

      const replacement = yield* provider
        .startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(replacement), true);

      const barrierThreadId = asThreadId("thread-destroyed-replacement-barrier");
      const barrierSession = yield* provider.startSession(barrierThreadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId: barrierThreadId,
        runtimeMode: "full-access",
      });
      const received = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach((event) => Ref.update(received, (events) => [...events, event])),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      fanout.codex.emit({
        type: "content.delta",
        eventId: asEventId("evt-destroyed-old-output"),
        provider: CODEX_DRIVER,
        threadId,
        sessionIncarnationId: oldSession.sessionIncarnationId,
        createdAt: "2026-01-01T00:00:00.000Z",
        delta: "stale",
      });
      fanout.codex.emit({
        type: "session.exited",
        eventId: asEventId("evt-destroyed-old-exit"),
        provider: CODEX_DRIVER,
        threadId,
        sessionIncarnationId: oldSession.sessionIncarnationId,
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: { exitKind: "graceful" },
      });
      fanout.codex.emit({
        type: "session.started",
        eventId: asEventId("evt-destroyed-replacement-barrier"),
        provider: CODEX_DRIVER,
        threadId: barrierThreadId,
        sessionIncarnationId: barrierSession.sessionIncarnationId,
        createdAt: "2026-01-01T00:00:02.000Z",
        payload: {},
      });
      yield* Fiber.join(consumer);

      assert.deepEqual(
        (yield* Ref.get(received)).map((event) => event.eventId),
        [asEventId("evt-destroyed-replacement-barrier")],
      );
    }),
  );

  it.effect(
    "restores only an exact old incarnation that remains live after replacement failure",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("thread-live-replacement");
        const oldSession = yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        });
        fanout.codex.startSession.mockImplementationOnce(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: CODEX_DRIVER,
              method: "startSession",
              detail: "replacement failed without touching the old session",
            }),
          ),
        );

        const replacement = yield* provider
          .startSession(threadId, {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            threadId,
            runtimeMode: "full-access",
          })
          .pipe(Effect.exit);
        assert.equal(Exit.isFailure(replacement), true);

        const received = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
        const consumer = yield* Stream.take(provider.streamEvents, 1).pipe(
          Stream.runForEach((event) => Ref.update(received, (events) => [...events, event])),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        fanout.codex.emit({
          type: "content.delta",
          eventId: asEventId("evt-restored-live-output"),
          provider: CODEX_DRIVER,
          threadId,
          sessionIncarnationId: oldSession.sessionIncarnationId,
          createdAt: "2026-01-01T00:00:00.000Z",
          delta: "still current",
        });
        yield* Fiber.join(consumer);

        assert.deepEqual(
          (yield* Ref.get(received)).map((event) => event.eventId),
          [asEventId("evt-restored-live-output")],
        );
      }),
  );

  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        sessionIncarnationId: session.sessionIncarnationId,
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* advanceTestClock(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.type === "turn.completed" && entry.providerInstanceId === codexInstanceId,
        ),
        true,
      );
    }),
  );

  it.effect("preserves admission correlation and rejects an unstamped aware event", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-admission"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-admission"),
        runtimeMode: "full-access",
      });
      const admissionRequestId = CommandId.make("cmd-thread-admission");
      const sessionIncarnationId = RuntimeSessionId.make(String(session.sessionIncarnationId));
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        admissionRequestId,
        sessionIncarnationId,
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);
      fanout.codex.emit({
        type: "turn.started",
        eventId: asEventId("evt-correlated-admission"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: sessionIncarnationId,
        threadId: session.threadId,
        turnId: asTurnId("turn-correlated-admission"),
        admissionRequestId,
        sessionIncarnationId,
        payload: {},
      });
      fanout.codex.emit({
        type: "turn.started",
        eventId: asEventId("evt-legacy-admission"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: sessionIncarnationId,
        threadId: session.threadId,
        turnId: asTurnId("turn-legacy-admission"),
        payload: {},
      });
      yield* Fiber.join(consumer);

      const events = yield* Ref.get(receivedRef);
      assert.equal(events[0]?.providerInstanceId, codexInstanceId);
      assert.equal(events[0]?.admissionRequestId, admissionRequestId);
      assert.equal(events[0]?.sessionIncarnationId, sessionIncarnationId);
      assert.equal(events.length, 1);
    }),
  );

  it.effect("drops late events from a replaced provider adapter incarnation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-replaced-adapter");
      const oldSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/provider-replaced-adapter",
        runtimeMode: "full-access",
      });
      const currentSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/provider-replaced-adapter",
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);
      fanout.codex.emit({
        type: "turn.started",
        eventId: asEventId("evt-replaced-adapter-stale"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId: asTurnId("turn-replaced-adapter-stale"),
        sessionIncarnationId: oldSession.sessionIncarnationId,
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {},
      });
      fanout.claude.emit({
        type: "turn.started",
        eventId: asEventId("evt-replaced-adapter-current"),
        provider: ProviderDriverKind.make("claudeAgent"),
        threadId,
        turnId: asTurnId("turn-replaced-adapter-current"),
        sessionIncarnationId: currentSession.sessionIncarnationId,
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: {},
      });
      yield* Fiber.join(consumer);

      const events = yield* Ref.get(receivedRef);
      assert.deepEqual(
        events.map((event) => event.eventId),
        ["evt-replaced-adapter-current"],
      );
    }),
  );

  it.effect("filters an old same-instance adapter after registry rebuild", () =>
    Effect.gen(function* () {
      const oldCodex = makeFakeCodexAdapter();
      const rebuiltCodex = makeFakeCodexAdapter();
      const changes = yield* PubSub.unbounded<void>();
      const rebuiltSubscribed = yield* Deferred.make<void>();
      const rebuiltAdapter: ProviderAdapterShape<ProviderAdapterError> = {
        ...rebuiltCodex.adapter,
        streamEvents: rebuiltCodex.adapter.streamEvents.pipe(
          Stream.onStart(Deferred.succeed(rebuiltSubscribed, undefined)),
        ),
      };
      let currentAdapter: ProviderAdapterShape<ProviderAdapterError> = oldCodex.adapter;
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        getByInstance: () => Effect.succeed(currentAdapter),
        getInstanceInfo: (instanceId) =>
          Effect.succeed({
            instanceId,
            driverKind: ProviderDriverKind.make("codex"),
            displayName: undefined,
            enabled: true,
            continuationIdentity: {
              driverKind: ProviderDriverKind.make("codex"),
              continuationKey: "codex:instance:codex",
            },
          }),
        listInstances: () => Effect.succeed([codexInstanceId]),
        listProviders: () => Effect.succeed([ProviderDriverKind.make("codex")]),
        streamChanges: Stream.empty,
        subscribeChanges: PubSub.subscribe(changes),
      };
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = Layer.mergeAll(
        makeProviderServiceLive().pipe(
          Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
          Layer.provide(directoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(serverConfigTestLayer),
          Layer.provideMerge(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        ),
        directoryLayer,
        runtimeRepositoryLayer,
        NodeServices.layer,
      );
      const scope = yield* Scope.make();
      const services = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));
      const provider = yield* ProviderService.ProviderService.pipe(Effect.provide(services));
      const threadId = asThreadId("thread-same-instance-rebuild");
      const oldSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      currentAdapter = rebuiltAdapter;
      yield* PubSub.publish(changes, undefined);
      yield* Deferred.await(rebuiltSubscribed);
      const currentSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const received = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach((event) => Ref.update(received, (events) => [...events, event])),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      oldCodex.emit({
        type: "session.exited",
        eventId: asEventId("evt-old-same-instance-after-rebuild"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        sessionIncarnationId: oldSession.sessionIncarnationId,
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { exitKind: "graceful" },
      });
      rebuiltCodex.emit({
        type: "session.started",
        eventId: asEventId("evt-current-same-instance-after-rebuild"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        sessionIncarnationId: currentSession.sessionIncarnationId,
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: {},
      });
      yield* Fiber.join(consumer);

      assert.deepEqual(
        (yield* Ref.get(received)).map((event) => event.eventId),
        ["evt-current-same-instance-after-rebuild"],
      );
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        sessionIncarnationId: session.sessionIncarnationId,
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        sessionIncarnationId: session.sessionIncarnationId,
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        sessionIncarnationId: session.sessionIncarnationId,
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit({ ...event, sessionIncarnationId: session.sessionIncarnationId });
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("records provider metrics with the routed provider label", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-metrics"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-metrics"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider.interruptTurn({ threadId: session.threadId });
      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-1"),
        decision: "accept",
      });
      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-2"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });
      yield* provider.stopSession({ threadId: session.threadId });

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "interrupt",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "approval-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "user-input-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "rollback",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_sessions_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "stop",
          outcome: "success",
        }),
        true,
      );
    }),
  );

  it.effect(
    "records sendTurn metrics with the resolved provider when modelSelection is omitted",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;

        const session = yield* provider.startSession(asThreadId("thread-send-metrics"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-send-metrics"),
          cwd: "/tmp/project-send-metrics",
          runtimeMode: "full-access",
        });

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        const snapshots = yield* Metric.snapshot;

        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
            outcome: "success",
          }),
          true,
        );
        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turn_duration", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
          }),
          true,
        );
      }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("rejects session starts without an explicit provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-missing-instance-id"), {
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-missing-instance-id"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "Provider instance id is required for provider 'codex'.");
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects mismatched provider kind and provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      validation.claude.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-instance-mismatch"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-instance-mismatch"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(
        failure.issue,
        "Provider instance 'claudeAgent' belongs to driver 'claudeAgent', not 'codex'.",
      );
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
      assert.equal(validation.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);

      const invalidMessage = yield* Effect.result(
        provider.messageSessionAgent({
          threadId: asThreadId("thread-validation"),
          agentId: RuntimeTaskId.make("agent-1"),
          message: "   ",
        } as never),
      );
      assert.equal(invalidMessage._tag, "Failure");
      if (invalidMessage._tag === "Failure") {
        assert.equal(invalidMessage.failure._tag, "ProviderValidationError");
        if (invalidMessage.failure._tag === "ProviderValidationError") {
          assert.equal(invalidMessage.failure.operation, "ProviderService.messageSessionAgent");
          assert.equal(invalidMessage.failure.reason, "invalid-input");
        }
      }
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = "2026-01-01T00:00:00.000Z";
          return {
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});

describe("agent browser access", () => {
  const revokedThreads: Array<ThreadId> = [];

  const makeAgentBrowserProviderLayer = (
    enableAgentBrowserAccess: boolean,
    codex: ReturnType<typeof makeFakeCodexAdapter>,
    options: NonNullable<Parameters<typeof makeProviderServiceLive>[0]>,
  ) => {
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter }),
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    return makeProviderServiceLive(options).pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provideMerge(directoryLayer),
      Layer.provide(ServerSettings.ServerSettingsService.layerTest({ enableAgentBrowserAccess })),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );
  };

  const startSessionWith = (enableAgentBrowserAccess: boolean, threadId: ThreadId) =>
    Effect.gen(function* () {
      const issued: Array<ThreadId> = [];
      const codex = makeFakeCodexAdapter();
      const providerLayer = makeAgentBrowserProviderLayer(enableAgentBrowserAccess, codex, {
        issueMcpCredential: (request) =>
          Effect.sync(() => {
            issued.push(request.threadId);
            return undefined;
          }),
        revokeMcpCredential: (revoked) => Effect.sync(() => void revokedThreads.push(revoked)),
      });

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      return issued;
    });

  const issuedBrowserCredential = (threadId: ThreadId) => ({
    config: {
      environmentId: EnvironmentId.make("environment-browser-test"),
      threadId,
      providerSessionId: `provider-session-${threadId}`,
      providerInstanceId: codexInstanceId,
      endpoint: `http://127.0.0.1:4321/mcp/provider-session-${threadId}`,
      authorizationHeader: "Bearer scoped-secret",
    },
  });

  // Credential issuance is the observable that matters: it is the only place a
  // credential is minted, and `/mcp` accepts nothing else, so withholding it is
  // what actually denies every provider and external MCP client.
  it.effect("requests no MCP credential when agent browser access is off", () =>
    Effect.gen(function* () {
      const issued = yield* startSessionWith(false, asThreadId("thread-browser-off"));

      assert.deepEqual(issued, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("revokes an already-issued credential when access is off", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-browser-revoke");
      revokedThreads.length = 0;

      yield* startSessionWith(false, threadId);

      // Clearing the in-memory map is not enough: a token issued before the
      // toggle flipped stays valid against `/mcp` for its whole liveness
      // window, and later turns refresh it.
      assert.deepEqual(revokedThreads, [threadId]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("requests an MCP credential when agent browser access is on", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-browser-on");

      const issued = yield* startSessionWith(true, threadId);

      assert.deepEqual(issued, [threadId]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("revokes the MCP credential when an adapter session exits on its own", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-browser-terminal");
      const codex = makeFakeCodexAdapter();
      const revoked = yield* Deferred.make<ThreadId>();
      const providerLayer = makeAgentBrowserProviderLayer(true, codex, {
        issueMcpCredential: (request) => Effect.succeed(issuedBrowserCredential(request.threadId)),
        revokeMcpCredential: (revokedThreadId) =>
          Deferred.succeed(revoked, revokedThreadId).pipe(Effect.asVoid),
      });

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const session = yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        });
        assert.isDefined(McpProviderSession.readMcpProviderSession(threadId));
        yield* codex.stopSession(threadId);
        yield* Effect.yieldNow;
        codex.emit({
          type: "session.exited",
          eventId: asEventId("evt-browser-terminal"),
          provider: CODEX_DRIVER,
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId,
          sessionIncarnationId: session.sessionIncarnationId,
          payload: { exitKind: "error" },
        });

        assert.equal(yield* Deferred.await(revoked), threadId);
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
      }).pipe(Effect.provide(providerLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restores MCP and the directory binding before exposing recovered activity", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-restart-adoption");
      const codex = makeFakeCodexAdapter();
      const order: string[] = [];
      const recoveredTurnId = TurnId.make("turn-restart-adoption");
      const recoveredRequestId = CommandId.make("request-restart-adoption");
      let recoveredSession: ProviderSession | undefined;
      const recoveryAdapter: ProviderAdapterShape<ProviderAdapterError> = {
        ...codex.adapter,
        recoverSession: (input) =>
          Effect.gen(function* () {
            assert.isDefined(McpProviderSession.readMcpProviderSession(threadId));
            order.push("recover");
            const session = yield* codex.startSession(input);
            recoveredSession = {
              ...session,
              status: "running",
              activeTurnId: recoveredTurnId,
              activeTurnRequestId: recoveredRequestId,
            };
            return recoveredSession;
          }),
        activateRecoveredSession: () =>
          Effect.sync(() => {
            order.push("activate");
            codex.emit({
              type: "content.delta",
              eventId: asEventId("evt-restart-adopted-output"),
              provider: CODEX_DRIVER,
              threadId,
              turnId: recoveredTurnId,
              sessionIncarnationId: recoveredSession!.sessionIncarnationId,
              createdAt: "2026-01-01T00:00:00.000Z",
              delta: "recovered",
            });
          }),
      };
      const providerLayer = makeAgentBrowserProviderLayer(
        true,
        { ...codex, adapter: recoveryAdapter },
        {
          issueMcpCredential: (request) =>
            Effect.sync(() => {
              order.push("mcp");
              return issuedBrowserCredential(request.threadId);
            }),
          revokeMcpCredential: () => Effect.void,
        },
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        codex.removeSession(threadId);
        order.length = 0;
        const recoveredEvents = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
        const consumer = yield* Stream.take(provider.streamEvents, 1).pipe(
          Stream.runForEach((event) => Ref.update(recoveredEvents, (events) => [...events, event])),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* provider.recoverRestartSessions!();
        yield* Fiber.join(consumer);

        assert.deepEqual(order, ["mcp", "recover", "activate"]);
        const [recoveredEvent] = yield* Ref.get(recoveredEvents);
        assert.equal(recoveredEvent?.eventId, asEventId("evt-restart-adopted-output"));
        assert.equal(recoveredEvent?.turnId, recoveredTurnId);
        assert.equal(recoveredEvent?.admissionRequestId, recoveredRequestId);
        const binding = Option.getOrThrow(yield* directory.getBinding(threadId));
        assert.equal(
          (binding.runtimePayload as { readonly lastRuntimeEvent?: string }).lastRuntimeEvent,
          "provider.restart-adopted",
        );
      }).pipe(Effect.provide(providerLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("revokes the MCP credential even when explicit adapter stop fails", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-browser-stop-failure");
      const codex = makeFakeCodexAdapter();
      const revoked = yield* Deferred.make<ThreadId>();
      codex.stopSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: CODEX_DRIVER,
            method: "stopSession",
            detail: "synthetic stop failure",
          }),
        ),
      );
      const providerLayer = makeAgentBrowserProviderLayer(true, codex, {
        issueMcpCredential: (request) => Effect.succeed(issuedBrowserCredential(request.threadId)),
        revokeMcpCredential: (revokedThreadId) =>
          Deferred.succeed(revoked, revokedThreadId).pipe(Effect.asVoid),
      });

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        });
        assert.isDefined(McpProviderSession.readMcpProviderSession(threadId));

        const stopped = yield* provider.stopSession({ threadId }).pipe(Effect.result);

        assert.equal(stopped._tag, "Failure");
        assert.equal(yield* Deferred.await(revoked), threadId);
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
      }).pipe(Effect.provide(providerLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
