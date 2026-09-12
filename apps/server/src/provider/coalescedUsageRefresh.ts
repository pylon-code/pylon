import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";

/** A burst is one read after the shared one-minute freshness window. No idle polling. */
export const USAGE_RECONCILIATION_DELAY_MS = 60_000;

export const makeCoalescedUsageRefresh = Effect.fn("makeCoalescedUsageRefresh")(function* (
  refresh: Effect.Effect<void>,
) {
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  let running: Fiber.Fiber<void> | undefined;
  let pending = false;
  let stopped = false;

  const worker = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(USAGE_RECONCILIATION_DELAY_MS);
      const shouldRead = yield* lock.withPermits(1)(
        Effect.sync(() => {
          if (stopped) return false;
          pending = false;
          return true;
        }),
      );
      if (!shouldRead) return;
      yield* refresh.pipe(Effect.ignoreCause({ log: true }));
      const again = yield* lock.withPermits(1)(
        Effect.sync(() => {
          if (!stopped && pending) return true;
          running = undefined;
          return false;
        }),
      );
      if (!again) return;
    }
  });

  const request = lock.withPermits(1)(
    Effect.gen(function* () {
      if (stopped) return;
      pending = true;
      if (!running) running = yield* worker.pipe(Effect.forkIn(scope));
    }),
  );
  const stop = Effect.gen(function* () {
    const fiber = yield* lock.withPermits(1)(
      Effect.sync(() => {
        stopped = true;
        pending = false;
        return running;
      }),
    );
    if (fiber) yield* Fiber.interrupt(fiber);
  });
  return { request, stop };
});
