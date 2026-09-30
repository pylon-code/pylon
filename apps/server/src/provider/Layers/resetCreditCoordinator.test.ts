import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { ResetCreditCoordinator, layerTest } from "./resetCreditCoordinator.ts";

it.layer(layerTest)("Reset credit attempts", (it) => {
  it.effect("uses the durable client request identity at the provider boundary", () =>
    Effect.gen(function* () {
      const coordinator = yield* ResetCreditCoordinator;
      const requestId = "3171f734-07a2-4e7d-8a9f-5b7939090bbf";
      const keys: string[] = [];
      yield* coordinator.redeem("restarted-account", requestId, (key) =>
        Effect.sync(() => {
          keys.push(key);
          return { outcome: "alreadyRedeemed" as const };
        }),
      );
      expect(keys).toEqual([requestId]);
    }),
  );
  it.effect("coalesces overlapping confirmations from two instances sharing an account", () =>
    Effect.gen(function* () {
      const coordinator = yield* ResetCreditCoordinator;
      const release = yield* Deferred.make<void>();
      const keys: string[] = [];
      const consume = (key: string) =>
        Effect.gen(function* () {
          keys.push(key);
          yield* Deferred.await(release);
          return { outcome: "reset" as const };
        });
      const first = yield* Effect.forkChild(coordinator.redeem("shared-home", "click-a", consume), {
        startImmediately: true,
      });
      const second = yield* Effect.forkChild(
        coordinator.redeem("shared-home", "click-b", consume),
        { startImmediately: true },
      );
      expect(keys).toHaveLength(1);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toEqual({ outcome: "reset" });
      expect(yield* Fiber.join(second)).toEqual({ outcome: "reset" });
      expect(keys).toHaveLength(1);
      expect(yield* coordinator.redeem("shared-home", "click-b", consume)).toEqual({
        outcome: "reset",
      });
      expect(keys).toHaveLength(1);
      yield* coordinator.redeem("shared-home", "new-confirmation", consume);
      expect(keys).toHaveLength(2);
      expect(keys[1]).not.toBe(keys[0]);
    }),
  );

  it.effect("retains the uncertain key and remembers every retried request", () =>
    Effect.gen(function* () {
      const coordinator = yield* ResetCreditCoordinator;
      const keys: string[] = [];
      const failed = yield* coordinator
        .redeem("account", "first", (key) =>
          Effect.sync(() => keys.push(key)).pipe(Effect.andThen(Effect.fail("connection lost"))),
        )
        .pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      const consume = (key: string) =>
        Effect.sync(() => {
          keys.push(key);
          return { outcome: "alreadyRedeemed" as const, warning: "Refresh needed" };
        });
      const result = yield* coordinator.redeem("account", "retry-from-another-client", consume);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
      expect(yield* coordinator.redeem("account", "first", consume)).toEqual(result);
      expect(keys).toHaveLength(2);
    }),
  );

  it.effect("releases the attempt key only for a failure the caller calls settled", () =>
    Effect.gen(function* () {
      const coordinator = yield* ResetCreditCoordinator;
      const keys: string[] = [];
      const fail = (reason: string) => (key: string) =>
        Effect.sync(() => keys.push(key)).pipe(Effect.andThen(Effect.fail(reason)));
      const isSettled = (reason: string) => reason === "cooldown";
      yield* coordinator
        .redeem("settling-account", "first", fail("timeout"), isSettled)
        .pipe(Effect.result);
      yield* coordinator
        .redeem("settling-account", "second", fail("cooldown"), isSettled)
        .pipe(Effect.result);
      yield* coordinator
        .redeem("settling-account", "third", fail("timeout"), isSettled)
        .pipe(Effect.result);
      expect(keys).toEqual(["first", "first", "third"]);
    }),
  );

  it.effect("allows independent accounts while another account waits", () =>
    Effect.gen(function* () {
      const coordinator = yield* ResetCreditCoordinator;
      const release = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        coordinator.redeem("home-a", "click", () =>
          Deferred.await(release).pipe(Effect.as({ outcome: "reset" as const })),
        ),
        { startImmediately: true },
      );
      expect(
        yield* coordinator.redeem("home-b", "click", () =>
          Effect.succeed({ outcome: "nothingToReset" }),
        ),
      ).toEqual({ outcome: "nothingToReset" });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
    }),
  );

  it.effect("keeps the attempt key after interruption", () =>
    Effect.gen(function* () {
      const coordinator = yield* ResetCreditCoordinator;
      const keys: string[] = [];
      const interrupted = yield* Effect.forkChild(
        coordinator.redeem("home", "click", (key) =>
          Effect.sync(() => keys.push(key)).pipe(Effect.andThen(Effect.never)),
        ),
        { startImmediately: true },
      );
      yield* Fiber.interrupt(interrupted);
      yield* coordinator.redeem("home", "click", (key) =>
        Effect.sync(() => {
          keys.push(key);
          return { outcome: "alreadyRedeemed" as const };
        }),
      );
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
    }),
  );
});
