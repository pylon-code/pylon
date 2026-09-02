import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { PrimeAgentAdapterShape } from "../Services/PrimeAgentAdapter.ts";
import type { ProviderRuntimeFence } from "../ProviderDriver.ts";
import { fencePrimeAgentAdapter } from "./PrimeAgentGenerationFence.ts";

it.effect("rejects a session result and queued events released after replacement", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(true);
    const sessionStarted = yield* Deferred.make<void>();
    const releaseSession = yield* Deferred.make<void>();
    const listStarted = yield* Deferred.make<void>();
    const releaseList = yield* Deferred.make<void>();
    const releaseEvent = yield* Deferred.make<void>();
    const fence: ProviderRuntimeFence = {
      generation: {},
      configRevision: "private-test-revision",
      isCurrent: Ref.get(current),
    };
    const raw = {
      provider: ProviderDriverKind.make("primeAgent"),
      startSession: () =>
        Deferred.succeed(sessionStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSession)),
          Effect.as({ threadId: "thread-a" }),
        ),
      listSessions: () =>
        Deferred.succeed(listStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseList)),
          Effect.as([{ threadId: "thread-a" }]),
        ),
      hasSession: () => Effect.succeed(true),
      streamEvents: Deferred.await(releaseEvent).pipe(
        Effect.as({ type: "session.started" }),
        Stream.fromEffect,
      ),
    } as unknown as PrimeAgentAdapterShape;
    const adapter = fencePrimeAgentAdapter(raw, fence);

    const startFiber = yield* adapter
      .startSession({} as never)
      .pipe(Effect.result, Effect.forkChild);
    const eventFiber = yield* adapter.streamEvents.pipe(Stream.runCollect, Effect.forkChild);
    const listFiber = yield* adapter.listSessions().pipe(Effect.forkChild);
    yield* Deferred.await(sessionStarted);
    yield* Deferred.await(listStarted);
    yield* Ref.set(current, false);
    yield* Deferred.succeed(releaseSession, undefined);
    yield* Deferred.succeed(releaseList, undefined);
    yield* Deferred.succeed(releaseEvent, undefined);

    const startResult = yield* Fiber.join(startFiber);
    expect(startResult._tag).toBe("Failure");
    expect(Array.from(yield* Fiber.join(eventFiber))).toEqual([]);
    expect(yield* Fiber.join(listFiber)).toEqual([]);
    expect(yield* adapter.listSessions()).toEqual([]);
    expect(yield* adapter.hasSession("thread-a" as never)).toBe(false);
  }),
);
