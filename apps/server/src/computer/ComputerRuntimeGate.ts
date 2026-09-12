import { ComputerSetupError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

/** One environment-owned admission gate shared by management and all provider connections. */
export class ComputerRuntimeGate extends Context.Service<
  ComputerRuntimeGate,
  {
    readonly access: <A, E, R>(
      work: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ComputerSetupError, R>;
    readonly maintenance: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly register: (close: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/computer/ComputerRuntimeGate") {
  static readonly layer = Layer.effect(
    ComputerRuntimeGate,
    Effect.gen(function* () {
      const gate = yield* Semaphore.make(1);
      const consumers = new Set<Effect.Effect<void>>();
      let paused = 0;
      const unavailable = () =>
        new ComputerSetupError({
          operation: "access",
          message: "Cua Driver maintenance is in progress. Retry when setup finishes.",
        });
      return ComputerRuntimeGate.of({
        access: (work) =>
          Effect.gen(function* () {
            if (paused > 0) return yield* unavailable();
            return yield* gate.withPermit(
              Effect.gen(function* () {
                if (paused > 0) return yield* unavailable();
                return yield* work;
              }),
            );
          }),
        maintenance: (work) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              paused += 1;
            }),
            () =>
              gate.withPermit(
                Effect.forEach(consumers, (close) => close, { discard: true }).pipe(
                  Effect.andThen(work),
                ),
              ),
            () =>
              Effect.sync(() => {
                paused -= 1;
              }),
          ),
        register: (close) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              consumers.add(close);
            }),
            () =>
              Effect.sync(() => {
                consumers.delete(close);
              }),
          ),
      });
    }),
  );
}
