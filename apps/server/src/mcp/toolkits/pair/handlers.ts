/**
 * Pair toolkit handlers.
 *
 * STUB: written by the lead so the contract and tests compile. The executor
 * replaces `make`; the exported layer name must not change.
 *
 * @module mcp/toolkits/pair/handlers
 */
import * as Effect from "effect/Effect";

import { PairFailedError, PairToolkit } from "./tools.ts";

const notImplemented = () =>
  Effect.fail(new PairFailedError({ cause: new Error("pair toolkit is not implemented") }));

const make = Effect.sync(() =>
  PairToolkit.of({
    pair_start: notImplemented,
    pair_handoff: notImplemented,
    pair_await: notImplemented,
    pair_stop: notImplemented,
  }),
);

export const PairToolkitHandlersLive = PairToolkit.toLayer(make);
