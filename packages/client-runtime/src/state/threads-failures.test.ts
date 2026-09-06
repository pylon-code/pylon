import {
  EnvironmentId,
  EventId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ConnectionWakeups, type ConnectionWakeup } from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  makeEnvironmentThreadState,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
} from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = ThreadId.make("thread-1");
const THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Cached thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "ModelA" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};
const SNAPSHOT = { snapshotSequence: 7, thread: THREAD };
const CONNECTED_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

const makeHarness = Effect.fn("TestThreadFailures.makeHarness")(function* (options?: {
  readonly httpNone?: boolean;
  readonly initialLoad?: Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>>;
  readonly stream?: Stream.Stream<OrchestrationThreadStreamItem, Error>;
}) {
  const subscriptions = yield* Queue.unbounded<{
    readonly events: Queue.Queue<OrchestrationThreadStreamItem, Error>;
    readonly closed: Deferred.Deferred<void>;
  }>();
  const opened = yield* Ref.make(0);
  const loads = yield* Ref.make(0);
  const wakeups = yield* Queue.unbounded<ConnectionWakeup>();
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<OrchestrationThreadStreamItem, Error>();
          const closed = yield* Deferred.make<void>();
          yield* Ref.update(opened, (n) => n + 1);
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
          yield* Queue.offer(subscriptions, { events, closed });
          return options?.stream ?? Stream.fromQueue(events);
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({ threadResumeCompletionMarker: true } as never),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const connectionState = yield* SubscriptionRef.make(CONNECTED_STATE);
  const sessionRef = yield* SubscriptionRef.make(Option.some(session));
  const supervisor = EnvironmentSupervisor.of({
    target: TARGET,
    state: connectionState,
    session: sessionRef,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        socketUrl: TARGET.wsBaseUrl,
        httpAuthorization: null,
        target: TARGET,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const cache = EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const state = yield* makeEnvironmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor, supervisor),
    Effect.provideService(EnvironmentCacheStore, cache),
    Effect.provideService(ConnectionWakeups, { changes: Stream.fromQueue(wakeups) }),
    Effect.provideService(ThreadSnapshotLoader, {
      load: () =>
        Ref.update(loads, (n) => n + 1).pipe(
          Effect.andThen(
            options?.initialLoad ??
              Effect.succeed(options?.httpNone ? Option.none() : Option.some(SNAPSHOT)),
          ),
        ),
    }),
  );
  const observe = (predicate: (value: EnvironmentThreadState) => boolean) =>
    SubscriptionRef.changes(state).pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return {
    state,
    observe,
    subscriptions,
    opened,
    loads,
    connectionState,
    sessionRef,
    session,
    wakeups,
  };
});

const protocolError = (error: Error) =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({ message: error.message, cause: error }),
  });

const synchronize = Effect.fn("TestThreadFailures.synchronize")(function* (
  events: Queue.Queue<OrchestrationThreadStreamItem, Error>,
) {
  yield* Queue.offer(events, { kind: "snapshot", snapshot: SNAPSHOT });
  yield* Queue.offer(events, { kind: "synchronized" });
});

describe("terminated thread loads", () => {
  it.effect("reports initializer defects without exposing raw errors or retrying", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        initialLoad: Effect.die(new Error("SYNTHETIC_PRIVATE_LOADER_ERROR")),
      });
      const failed = yield* h.observe((s) => Option.isSome(s.error));
      expect(failed).toMatchObject({
        status: "empty",
        data: Option.none(),
        error: Option.some("Could not synchronize the thread."),
      });
      yield* TestClock.adjust("1 second");
      expect(yield* SubscriptionRef.get(h.state)).toEqual(failed);
      expect(yield* Ref.get(h.opened)).toBe(0);
      expect(yield* Ref.get(h.loads)).toBe(1);
    }),
  );

  it.effect.each([
    { kind: "protocol", httpNone: true },
    { kind: "protocol", httpNone: false },
    { kind: "fatal", httpNone: true },
    { kind: "fatal", httpNone: false },
  ] as const)(
    "retains $kind errors through connection notifications (empty: $httpNone)",
    ({ kind, httpNone }) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ httpNone });
        const first = yield* Queue.take(h.subscriptions);
        const error = new Error("SYNTHETIC_PRIVATE_STREAM_ERROR");
        yield* Queue.failCause(
          first.events,
          kind === "fatal" ? Cause.die(error) : Cause.fail(protocolError(error)),
        );
        yield* Deferred.await(first.closed);
        const failed = yield* h.observe((s) => Option.isSome(s.error));
        expect(failed.status).toBe(httpNone ? "empty" : "cached");
        expect(failed.data).toEqual(httpNone ? Option.none() : Option.some(THREAD));
        expect(failed.error).toEqual(Option.some("Could not synchronize the thread."));
        for (const connection of [
          AVAILABLE_CONNECTION_STATE,
          { ...CONNECTED_STATE, phase: "connecting" as const },
          CONNECTED_STATE,
        ]) {
          yield* SubscriptionRef.set(h.connectionState, connection);
          yield* TestClock.adjust("0 millis");
          expect(yield* SubscriptionRef.get(h.state)).toEqual(failed);
        }
        yield* SubscriptionRef.set(h.sessionRef, Option.some({ ...h.session }));
        if (kind === "fatal") {
          yield* TestClock.adjust("1 second");
          expect(yield* Ref.get(h.opened)).toBe(1);
          expect(yield* SubscriptionRef.get(h.state)).toEqual(failed);
          return;
        }
        const next = yield* Queue.take(h.subscriptions);
        expect((yield* SubscriptionRef.get(h.state)).error).toEqual(Option.none());
        yield* synchronize(next.events);
        expect((yield* h.observe((s) => s.status === "live")).error).toEqual(Option.none());
      }),
  );

  it.effect("retries a protocol failure on foreground without a replacement session", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ httpNone: true });
      const first = yield* Queue.take(h.subscriptions);
      yield* Queue.fail(first.events, protocolError(new Error("incompatible snapshot")));
      yield* Deferred.await(first.closed);
      yield* h.observe((s) => Option.isSome(s.error));
      yield* Queue.offer(h.wakeups, "application-active");
      const next = yield* Queue.take(h.subscriptions);
      expect((yield* SubscriptionRef.get(h.state)).error).toEqual(Option.none());
      yield* synchronize(next.events);
      yield* h.observe((s) => s.status === "live");
    }),
  );

  it.effect("retains transport and domain recovery policies", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ httpNone: true });
      const first = yield* Queue.take(h.subscriptions);
      yield* Queue.fail(
        first.events,
        new RpcClientError.RpcClientError({
          reason: new Socket.SocketCloseError({ code: 1006, closeReason: "connection lost" }),
        }),
      );
      yield* Deferred.await(first.closed);
      yield* TestClock.adjust("1 second");
      expect((yield* SubscriptionRef.get(h.state)).error).toEqual(Option.none());
      expect(yield* Ref.get(h.opened)).toBe(1);
      yield* SubscriptionRef.set(h.sessionRef, Option.some({ ...h.session }));
      const second = yield* Queue.take(h.subscriptions);
      yield* Queue.fail(second.events, new Error("thread not found yet"));
      yield* Deferred.await(second.closed);
      expect((yield* h.observe((s) => Option.isSome(s.error))).error).toEqual(
        Option.some("thread not found yet"),
      );
      yield* TestClock.adjust("250 millis");
      const third = yield* Queue.take(h.subscriptions);
      yield* synchronize(third.events);
      expect((yield* h.observe((s) => s.status === "live")).error).toEqual(Option.none());
    }),
  );

  it.effect.each([
    { kind: "protocol", deleted: false },
    { kind: "fatal", deleted: false },
    { kind: "domain", deleted: false },
    { kind: "protocol", deleted: true },
    { kind: "fatal", deleted: true },
    { kind: "domain", deleted: true },
  ] as const)(
    "preserves buffered outcomes after $kind failure (deleted: $deleted)",
    ({ kind, deleted }) =>
      Effect.gen(function* () {
        const burst = yield* Deferred.make<void>();
        const error = new Error(
          kind === "domain" ? "buffered domain failure" : "SYNTHETIC_PRIVATE_BUFFER_ERROR",
        );
        const items: OrchestrationThreadStreamItem[] = [
          { kind: "snapshot", snapshot: SNAPSHOT },
          { kind: "synchronized" },
          {
            kind: "event",
            event: {
              eventId: EventId.make("buffered-event"),
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              sequence: 8,
              occurredAt: THREAD.createdAt,
              aggregateKind: "thread",
              aggregateId: THREAD_ID,
              type: "thread.meta-updated",
              payload: {
                threadId: THREAD_ID,
                title: "Buffer drained",
                updatedAt: THREAD.createdAt,
              },
            },
          },
        ];
        if (deleted)
          items.push({
            kind: "event",
            event: {
              eventId: EventId.make("buffered-deletion"),
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              sequence: 9,
              occurredAt: THREAD.createdAt,
              aggregateKind: "thread",
              aggregateId: THREAD_ID,
              type: "thread.deleted",
              payload: { threadId: THREAD_ID, deletedAt: THREAD.createdAt },
            },
          });
        const failure =
          kind === "fatal"
            ? Cause.die(error)
            : Cause.fail(kind === "domain" ? error : protocolError(error));
        const h = yield* makeHarness({
          httpNone: true,
          stream: Stream.fromEffect(Deferred.await(burst)).pipe(
            Stream.flatMap(() => Stream.fromIterable(items)),
            Stream.concat(Stream.failCause(failure)),
          ),
        });
        const subscription = yield* Queue.take(h.subscriptions);
        yield* Deferred.succeed(burst, undefined);
        yield* Deferred.await(subscription.closed);
        const final = yield* h.observe((s) =>
          deleted
            ? s.status === "deleted"
            : Option.getOrNull(s.data)?.title === "Buffer drained" && Option.isSome(s.error),
        );
        if (deleted) {
          expect(final.data).toEqual(Option.none());
          expect(final.error).toEqual(Option.none());
        } else {
          expect(final.status).toBe("cached");
          expect(final.error).toEqual(
            Option.some(kind === "domain" ? error.message : "Could not synchronize the thread."),
          );
        }
      }),
  );
});
