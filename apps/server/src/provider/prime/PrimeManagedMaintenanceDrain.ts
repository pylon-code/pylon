import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** The subscription and worker belong to the server, independently of clients. */
export const start = Effect.fn("PrimeManagedMaintenanceDrain.start")(function* (input: {
  readonly subscribe: Effect.Effect<Stream.Stream<ProviderInstanceId>, never, Scope.Scope>;
  readonly initialInstances?: Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
  readonly drain: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
}) {
  const changes = yield* input.subscribe;
  yield* changes.pipe(Stream.runForEach(input.drain), Effect.forkScoped);
  if (input.initialInstances !== undefined)
    yield* Effect.forEach(yield* input.initialInstances, input.drain, { discard: true });
});
