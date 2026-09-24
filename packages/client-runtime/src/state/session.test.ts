import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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

import { currentSessionStateReceipt, initialConfigOption } from "./session.ts";

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
});
