import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import {
  makePrimeAgentEventPubSub,
  PRIME_AGENT_EVENT_BUFFER_CAPACITY,
  PRIME_AGENT_EVENT_TEARDOWN_TIMEOUT_MS,
  shutdownPrimeAgentEventPubSub,
} from "./PrimeAgentEventBuffer.ts";

it.effect("backpressures capacity plus one and drains every event in FIFO order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pubsub = yield* makePrimeAgentEventPubSub<number>();
      const subscription = yield* PubSub.subscribe(pubsub);

      for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY; index += 1) {
        yield* PubSub.publish(pubsub, index);
      }
      const blockedOffer = yield* PubSub.publish(pubsub, PRIME_AGENT_EVENT_BUFFER_CAPACITY).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      expect(blockedOffer.pollUnsafe()).toBeUndefined();

      const first = yield* PubSub.take(subscription);
      yield* Fiber.join(blockedOffer);
      const remaining = Array.from(yield* PubSub.takeAll(subscription));
      expect([first, ...remaining]).toEqual(
        Array.from({ length: PRIME_AGENT_EVENT_BUFFER_CAPACITY + 1 }, (_, index) => index),
      );
    }),
  ),
);

it.effect("forces an observable shutdown when a teardown drain remains backpressured", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pubsub = yield* makePrimeAgentEventPubSub<number>();
      yield* PubSub.subscribe(pubsub);
      for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY; index += 1) {
        yield* PubSub.publish(pubsub, index);
      }

      const nativeCleanup = yield* Deferred.make<void>();
      const closeFiber = yield* shutdownPrimeAgentEventPubSub({
        component: "daemon",
        pubSub: pubsub,
        drain: PubSub.publish(pubsub, PRIME_AGENT_EVENT_BUFFER_CAPACITY).pipe(
          Effect.andThen(Deferred.succeed(nativeCleanup, undefined)),
          Effect.asVoid,
          Effect.uninterruptible,
        ),
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(closeFiber.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust(PRIME_AGENT_EVENT_TEARDOWN_TIMEOUT_MS);
      yield* Fiber.join(closeFiber);
      expect(yield* Deferred.isDone(nativeCleanup)).toBe(true);
      expect(yield* PubSub.isShutdown(pubsub)).toBe(true);
      expect(yield* PubSub.publish(pubsub, 999)).toBe(false);
    }),
  ),
);
