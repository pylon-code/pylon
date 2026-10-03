import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  IsoDateTime,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2RuntimePolicy } from "../../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "../../orchestration-v2/ProviderEventIngestor.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeLegacyAdapterV2 } from "./LegacyAdapterV2Bridge.ts";
import * as Maintenance from "./LegacyAdapterV2Maintenance.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

// Pylon regression coverage: the Prime v1->v2 bridge acquires a maintenance
// runtime fence inside the v2 session scope. Releasing that scope through the
// upstream ProviderSessionManager must stop the legacy runtime and publish the
// drain receipt, including when the release records fail to persist.

const driver = ProviderDriverKind.make("primeAgent");
const instanceId = ProviderInstanceId.make("prime-session-manager");
const time = IsoDateTime.make("2026-10-03T12:00:00.000Z");
const modelSelection = { instanceId, model: "prime-model" } satisfies ModelSelection;
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapterV2RuntimePolicy;

type FailingReleaseWrites = Ref.Ref<boolean>;

interface LegacyRuntime {
  readonly stopped: Queue.Queue<ThreadId>;
  readonly failStream: Deferred.Deferred<void>;
}

function legacyAdapter(runtime: LegacyRuntime): ProviderAdapterShape<never> {
  const session = (threadId: ThreadId): ProviderSession => ({
    provider: driver,
    providerInstanceId: instanceId,
    threadId,
    status: "ready",
    runtimeMode: "full-access",
    cwd: process.cwd(),
    model: "prime-model",
    createdAt: time,
    updatedAt: time,
  });
  return {
    provider: driver,
    capabilities: { sessionModelSwitch: "in-session", conversationRollback: "unsupported" },
    startSession: (input) => Effect.succeed(session(input.threadId)),
    sendTurn: (input) => Effect.die(`unused sendTurn ${input.threadId}`),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    stopSession: (threadId) => Queue.offer(runtime.stopped, threadId).pipe(Effect.asVoid),
    hasSession: () => Effect.succeed(true),
    listSessions: () => Effect.succeed([]),
    stopAll: () => Effect.void,
    // The daemon stream stays open until a test makes it fail, as when the
    // Prime daemon exits underneath a live session.
    streamEvents: Stream.fromEffect(Deferred.await(runtime.failStream)).pipe(
      Stream.flatMap(() => Stream.die(new Error("Prime daemon exited"))),
    ),
  };
}

const TestDatabaseLayer = SqlitePersistenceMemory;
const TestStoresLayer = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(TestDatabaseLayer),
);
const TestEventSinkLayer = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(TestStoresLayer, TestDatabaseLayer)),
);

// Fails stopped/error session writes with a defect, as a failed SQL commit does.
const makeFlakyEventSinkLayer = (failing: FailingReleaseWrites) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Effect.gen(function* () {
            const fails =
              (yield* Ref.get(failing)) &&
              input.events.some(
                (event) =>
                  event.type === "provider-session.updated" &&
                  (event.payload.status === "stopped" || event.payload.status === "error"),
              );
            if (fails) return yield* Effect.die(new Error("simulated commit failure"));
            return yield* delegate.write(input);
          }),
      });
    }),
  ).pipe(Layer.provide(TestEventSinkLayer));

const TestMcpRegistryLayer = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43124),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
  ),
  Layer.provide(
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-prime-session-manager")),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

function makeTestLayer(input: {
  readonly runtime: LegacyRuntime;
  readonly maintenance: Maintenance.LegacyAdapterV2MaintenanceShape;
  readonly failing: FailingReleaseWrites;
}) {
  const eventSinkLayer = makeFlakyEventSinkLayer(input.failing);
  const registryLayer = ProviderAdapterRegistry.makeSingleLayer(
    makeLegacyAdapterV2({
      instanceId,
      adapter: legacyAdapter(input.runtime),
      maintenance: input.maintenance,
    }),
  );
  const ingestorLayer = ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        eventSinkLayer,
        IdAllocator.layer,
        TestStoresLayer,
        ThreadCommandExecutor.layer,
      ),
    ),
  );
  return Layer.mergeAll(
    TestStoresLayer,
    eventSinkLayer,
    IdAllocator.layer,
    ProviderSessionManager.layerWithOptions({ idleTimeoutMs: 60_000 }).pipe(
      Layer.provide(
        Layer.mergeAll(
          registryLayer,
          eventSinkLayer,
          IdAllocator.layer,
          ingestorLayer,
          TestMcpRegistryLayer,
          TestStoresLayer,
        ),
      ),
    ),
  ).pipe(Layer.provide(NodeServices.layer));
}

const writeThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const now = yield* DateTime.now;
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: yield* idAllocator.allocate.project({ fixtureName: "prime-session-manager" }),
      title: "Prime session manager",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    yield* eventSink.write({
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId }),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
    return yield* idAllocator.allocate.providerSession({
      providerInstanceId: instanceId,
      threadId,
    });
  });

/** Waits for the next stopped/error session record after the current sequence. */
const nextSessionRecord = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    return yield* eventSink
      .stream({
        threadId,
        afterSequence: yield* eventSink.latestSequence({ threadId }),
        eventType: "provider-session.updated",
      })
      .pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "provider-session.updated" &&
            (event.payload.status === "stopped" || event.payload.status === "error"),
        ),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
  });

const makeHarness = Effect.gen(function* () {
  const runtime: LegacyRuntime = {
    stopped: yield* Queue.unbounded<ThreadId>(),
    failStream: yield* Deferred.make<void>(),
  };
  const maintenance = yield* Maintenance.make();
  const failing = yield* Ref.make(false);
  const drained = yield* maintenance.subscribeDrainedInstances;
  return { runtime, maintenance, failing, drained };
});

it.effect("a closed Prime bridge session drains its maintenance fence", () =>
  Effect.gen(function* () {
    const { runtime, maintenance, failing, drained } = yield* makeHarness;
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const threadId = ThreadId.make("thread-prime-session-manager-close");
      const providerSessionId = yield* writeThread(threadId);
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });

      // A live bridge runtime blocks provider maintenance.
      assert.equal((yield* maintenance.reserveProviderMaintenance(instanceId)).status, "busy");

      yield* manager.close(providerSessionId);
      assert.equal(yield* Queue.take(runtime.stopped), threadId);
      const drainedInstance = yield* Stream.runHead(drained.pipe(Stream.take(1)));
      assert.isTrue(drainedInstance._tag === "Some" && drainedInstance.value === instanceId);

      const reservation = yield* maintenance.reserveProviderMaintenance(instanceId);
      assert.equal(reservation.status, "reserved");
      // A reservation fences new runtime admission through the manager.
      const admission = yield* Effect.exit(
        manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy }),
      );
      assert.isTrue(Exit.isFailure(admission));
      if (reservation.status === "reserved") {
        yield* maintenance.releaseProviderMaintenance(reservation.reservation);
      }
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      assert.equal((yield* maintenance.reserveProviderMaintenance(instanceId)).status, "busy");
    }).pipe(Effect.provide(makeTestLayer({ runtime, maintenance, failing })));
  }).pipe(Effect.scoped),
);

it.effect("a Prime bridge release whose records fail still stops and drains the runtime", () =>
  Effect.gen(function* () {
    const { runtime, maintenance, failing, drained } = yield* makeHarness;
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread-prime-session-manager-failed-records");
      const providerSessionId = yield* writeThread(threadId);
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });

      yield* Ref.set(failing, true);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(manager.close(providerSessionId))));
      // The fence is released even though the stopped record did not persist.
      assert.equal(yield* Queue.take(runtime.stopped), threadId);
      assert.isTrue((yield* Stream.runHead(drained.pipe(Stream.take(1))))._tag === "Some");
      const reservation = yield* maintenance.reserveProviderMaintenance(instanceId);
      assert.equal(reservation.status, "reserved");
      if (reservation.status === "reserved") {
        yield* maintenance.releaseProviderMaintenance(reservation.reservation);
      }
      assert.equal(
        (yield* projectionStore.getThreadProjection(threadId)).providerSessions.at(-1)?.status,
        "ready",
      );

      // The upstream retry records the stop once the store recovers, without
      // reopening or stopping the legacy runtime again.
      yield* Ref.set(failing, false);
      const recorded = yield* nextSessionRecord(threadId);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(recorded);
      assert.equal(
        (yield* projectionStore.getThreadProjection(threadId)).providerSessions.at(-1)?.status,
        "stopped",
      );
      assert.equal(yield* Queue.size(runtime.stopped), 0);
    }).pipe(Effect.provide(makeTestLayer({ runtime, maintenance, failing })));
  }).pipe(Effect.scoped),
);

it.effect("a failed Prime daemon stream releases the session as an error and drains", () =>
  Effect.gen(function* () {
    const { runtime, maintenance, failing, drained } = yield* makeHarness;
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread-prime-session-manager-stream-failure");
      const providerSessionId = yield* writeThread(threadId);
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });

      const recorded = yield* nextSessionRecord(threadId);
      yield* Deferred.succeed(runtime.failStream, undefined);
      assert.equal(yield* Queue.take(runtime.stopped), threadId);
      assert.isTrue((yield* Stream.runHead(drained.pipe(Stream.take(1))))._tag === "Some");
      yield* Fiber.join(recorded);
      assert.equal(
        (yield* projectionStore.getThreadProjection(threadId)).providerSessions.at(-1)?.status,
        "error",
      );
      assert.equal((yield* maintenance.reserveProviderMaintenance(instanceId)).status, "reserved");
    }).pipe(Effect.provide(makeTestLayer({ runtime, maintenance, failing })));
  }).pipe(Effect.scoped),
);
