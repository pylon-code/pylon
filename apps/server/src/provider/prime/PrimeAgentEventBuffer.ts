import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";

/**
 * Prime event delivery is lossless and FIFO during normal operation. If a
 * subscriber remains permanently stalled during adapter teardown, the adapter
 * reports the forced-drop path and closes after this bounded drain deadline.
 */
export const PRIME_AGENT_EVENT_BUFFER_CAPACITY = 256;
export const PRIME_AGENT_EVENT_TEARDOWN_TIMEOUT_MS = 1_000;

export const makePrimeAgentEventPubSub = <A>() =>
  PubSub.bounded<A>(PRIME_AGENT_EVENT_BUFFER_CAPACITY);

export function shutdownPrimeAgentEventPubSub<A, E>(input: {
  readonly component: "acp" | "daemon";
  readonly pubSub: PubSub.PubSub<A>;
  readonly drain: Effect.Effect<void, E>;
}): Effect.Effect<void> {
  return Effect.raceFirst(
    input.drain,
    Effect.sleep(PRIME_AGENT_EVENT_TEARDOWN_TIMEOUT_MS).pipe(
      Effect.tap(() =>
        Effect.logError("Prime Agent event drain timed out during adapter teardown.", {
          component: input.component,
          timeoutMs: PRIME_AGENT_EVENT_TEARDOWN_TIMEOUT_MS,
          outcome: "forced-pubsub-shutdown",
        }),
      ),
      Effect.andThen(PubSub.shutdown(input.pubSub)),
    ),
  ).pipe(
    Effect.catchCause(() =>
      Effect.logError("Failed to drain Prime Agent sessions during adapter teardown.", {
        component: input.component,
        outcome: "forced-pubsub-shutdown",
      }),
    ),
    Effect.ensuring(PubSub.shutdown(input.pubSub)),
    Effect.asVoid,
  );
}
