import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { AVAILABLE_CONNECTION_STATE, type SupervisorConnectionState } from "../connection/model.ts";
import {
  type ConnectedInitialConfig,
  connectedInitialConfigChanges,
  connectedInitialConfigForState,
  initialConfigOption,
} from "./session.ts";

class TestConfigError extends Schema.TaggedError<TestConfigError>()("TestConfigError", {
  message: Schema.String,
}) {}

describe("environment session state", () => {
  it.effect("turns an initial config failure into an empty value", () =>
    Effect.gen(function* () {
      const result = yield* initialConfigOption(
        Effect.fail(new TestConfigError({ message: "temporary failure" })),
      );
      expect(Option.isNone(result)).toBe(true);
    }),
  );

  it("rejects a previous server's capability even when its replacement reuses the generation", () => {
    const first = { ...AVAILABLE_CONNECTION_STATE, phase: "connected" as const, generation: 1 };
    const replacement = { ...first };
    const previousConfig = Option.some({ state: first, config: "pasted-text-path-only" });
    expect(connectedInitialConfigForState(first, previousConfig)).toBe("pasted-text-path-only");
    expect(connectedInitialConfigForState(replacement, previousConfig)).toBeNull();
    expect(connectedInitialConfigForState(null, previousConfig)).toBeNull();
    expect(connectedInitialConfigForState(first, Option.none())).toBeNull();
  });

  it.effect("does not publish a delayed old config after the same-ID lease is replaced", () =>
    Effect.gen(function* () {
      const first = { ...AVAILABLE_CONNECTION_STATE, phase: "connected" as const, generation: 1 };
      const replacement = { ...first };
      const startedA = yield* Deferred.make<void>();
      const configA = yield* Deferred.make<string>();
      const sessionA = {
        initialConfig: Effect.gen(function* () {
          yield* Deferred.succeed(startedA, undefined);
          return yield* Deferred.await(configA);
        }),
      };
      const sessionB = { initialConfig: Effect.succeed("B:unsupported") };
      const stateRef = yield* SubscriptionRef.make<SupervisorConnectionState>(first);
      const sessionRef = yield* SubscriptionRef.make(Option.some(sessionA));
      const collected = yield* connectedInitialConfigChanges(
        stateRef,
        SubscriptionRef.get(sessionRef),
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(startedA);
      yield* SubscriptionRef.set(sessionRef, Option.some(sessionB));
      yield* SubscriptionRef.set(stateRef, replacement);
      yield* Deferred.succeed(configA, "A:supported");
      const [oldEmission, newEmission] = yield* Fiber.join(collected);
      expect(Option.isNone(oldEmission!)).toBe(true);
      expect(connectedInitialConfigForState(replacement, newEmission!)).toBe("B:unsupported");
    }),
  );

  it.effect("rejects the last published A config while B is connected but still loading", () =>
    Effect.gen(function* () {
      const first = { ...AVAILABLE_CONNECTION_STATE, phase: "connected" as const, generation: 1 };
      const replacement = { ...first };
      const startedB = yield* Deferred.make<void>();
      const configB = yield* Deferred.make<string>();
      const sessionA = { initialConfig: Effect.succeed("A:supported") };
      const sessionB = {
        initialConfig: Effect.gen(function* () {
          yield* Deferred.succeed(startedB, undefined);
          return yield* Deferred.await(configB);
        }),
      };
      const stateRef = yield* SubscriptionRef.make<SupervisorConnectionState>(first);
      const sessionRef = yield* SubscriptionRef.make(Option.some(sessionA));
      const firstPublished = yield* Deferred.make<Option.Option<ConnectedInitialConfig<string>>>();
      const collected = yield* connectedInitialConfigChanges(
        stateRef,
        SubscriptionRef.get(sessionRef),
      ).pipe(
        Stream.tap((value) => Deferred.succeed(firstPublished, value).pipe(Effect.asVoid)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      const oldConfig = yield* Deferred.await(firstPublished);
      expect(connectedInitialConfigForState(first, oldConfig)).toBe("A:supported");
      yield* SubscriptionRef.set(sessionRef, Option.some(sessionB));
      yield* SubscriptionRef.set(stateRef, replacement);
      yield* Deferred.await(startedB);
      expect(connectedInitialConfigForState(replacement, oldConfig)).toBeNull();
      yield* Deferred.succeed(configB, "B:unsupported");
      const [, newConfig] = yield* Fiber.join(collected);
      expect(connectedInitialConfigForState(replacement, newConfig!)).toBe("B:unsupported");
    }),
  );
});
