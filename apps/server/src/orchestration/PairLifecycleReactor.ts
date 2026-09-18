/**
 * Keeps a pair executor in step with its lead: archived, deleted, and settled
 * together, and stopped when the lead is rewound. A sidecar over existing
 * commands and domain events; it adds no command, event, or decider branch.
 *
 * STUB: written by the lead so the tests compile. The executor replaces `make`;
 * the service tag, its shape, and `layer` must not change.
 *
 * @module orchestration/PairLifecycleReactor
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

export class PairLifecycleReactor extends Context.Service<
  PairLifecycleReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/PairLifecycleReactor") {}

export const make = Effect.sync(() => ({
  // Inert until implemented: the tests fail because nothing is dispatched.
  start: (): Effect.Effect<void, never, Scope.Scope> => Effect.void,
  drain: Effect.void,
}));

export const layer = Layer.effect(PairLifecycleReactor, make);
