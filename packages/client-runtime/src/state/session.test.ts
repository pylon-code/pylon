import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { rpcSessionOwner } from "../rpc/sessionOwner.ts";

import {
  type ConnectedInitialConfig,
  connectedInitialConfigChanges,
  connectedInitialConfigForState,
  currentSessionStateReceipt,
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

  it.effect("discards a delayed A authorization after B becomes the live session", () =>
    Effect.gen(function* () {
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("widget-session"),
        label: "Widget test",
        httpBaseUrl: "https://environment.test",
        wsBaseUrl: "wss://environment.test",
      });
      const preparedA: PreparedConnection = {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: "wss://environment.test/ws",
        httpAuthorization: null,
        target,
      };
      const preparedB: PreparedConnection = { ...preparedA };
      const firstSession = { marker: "A" } as unknown as RpcSession;
      const secondSession = { marker: "B" } as unknown as RpcSession;
      const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
        generation: 1,
      });
      const prepared = yield* SubscriptionRef.make(Option.some(preparedA));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state,
        prepared,
        session: yield* SubscriptionRef.make(Option.some(firstSession)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const authorization: AuthSessionState = {
        authenticated: true,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["dpop-access-token"],
          sessionCookieName: "t3_session",
        },
      };
      const started = yield* Deferred.make<void>();
      const response = yield* Deferred.make<AuthSessionState>();
      const delayedA = yield* currentSessionStateReceipt(
        supervisor,
        preparedA,
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(response))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* SubscriptionRef.set(prepared, Option.some(preparedB));
      yield* SubscriptionRef.set(supervisor.session, Option.some(secondSession));
      const connectedB: SupervisorConnectionState = {
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
        // A replacement supervisor may restart the numeric generation.
        generation: 1,
      };
      yield* SubscriptionRef.set(state, connectedB);
      yield* Deferred.succeed(response, authorization);
      expect(Option.isNone(yield* Fiber.join(delayedA))).toBe(true);
      expect(
        Option.isNone(
          yield* currentSessionStateReceipt(
            supervisor,
            preparedA,
            Effect.die("Stale A must not start another authorization request"),
          ),
        ),
      ).toBe(true);
      const current = yield* currentSessionStateReceipt(
        supervisor,
        preparedB,
        Effect.succeed(authorization),
      );
      expect(Option.getOrThrow(current).sessionOwner).toBe(rpcSessionOwner(secondSession));
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
