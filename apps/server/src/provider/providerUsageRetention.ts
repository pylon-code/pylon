import type { ServerProviderAuth, ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";
import * as RefModule from "effect/Ref";

/**
 * How long a reading keeps being shown after its probe starts failing.
 *
 * Past this the number is dropped rather than left to quietly mislead.
 */
export const USAGE_RETENTION_MAX_AGE = Duration.minutes(30);

/**
 * Decide whether a retained reading is still worth showing.
 *
 * Split out from the driver so the rule that governs a disappearing gauge is
 * testable without spawning a CLI.
 */
export function isRetainedUsageFresh(input: {
  readonly checkedAt: string;
  readonly nowMs: number;
  readonly maxAgeMs?: number | undefined;
}): boolean {
  const checkedAtMs = Date.parse(input.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return false;
  const age = input.nowMs - checkedAtMs;
  // A clock skewed into the future is not evidence of freshness.
  if (age < 0) return false;
  return age <= (input.maxAgeMs ?? Duration.toMillis(USAGE_RETENTION_MAX_AGE));
}

/**
 * Keep the last good usage reading across a failed probe.
 *
 * The usage endpoint is rate limited and an access token can lapse between
 * refreshes, so a single failure used to blank the gauge entirely — it vanished
 * and returned minutes later for no reason the user could see. A slightly old
 * number beats no number when deciding where to send work, and `checkedAt`
 * travels with it so the client can say how old it is.
 */
export function retainUsageLimits(
  lastKnown: Ref.Ref<ServerProviderUsageLimits | undefined>,
  usageLimits: ServerProviderUsageLimits | undefined,
): Effect.Effect<ServerProviderUsageLimits | undefined> {
  return Effect.gen(function* () {
    if (usageLimits) {
      yield* RefModule.set(lastKnown, usageLimits);
      return usageLimits;
    }
    const retained = yield* RefModule.get(lastKnown);
    if (!retained) return undefined;
    const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    if (isRetainedUsageFresh({ checkedAt: retained.checkedAt, nowMs })) return retained;
    yield* RefModule.set(lastKnown, undefined);
    return undefined;
  });
}

/**
 * Apply {@link retainUsageLimits} to a whole probed snapshot.
 *
 * A signed-out account has no capacity to retain, so its reading is cleared
 * rather than carried; anything else keeps the last good reading through a
 * failed or timed-out read. Codex reads its windows over the network inside
 * the status probe, where one slow answer would otherwise blank the gauge
 * until the next poll.
 */
export function retainSnapshotUsageLimits<
  Snapshot extends {
    readonly auth: ServerProviderAuth;
    readonly usageLimits?: ServerProviderUsageLimits | undefined;
  },
>(
  lastKnown: Ref.Ref<ServerProviderUsageLimits | undefined>,
  snapshot: Snapshot,
): Effect.Effect<Snapshot> {
  return Effect.gen(function* () {
    if (snapshot.auth.status === "unauthenticated") {
      yield* RefModule.set(lastKnown, undefined);
      const { usageLimits: _usageLimits, ...withoutUsage } = snapshot;
      return withoutUsage as Snapshot;
    }
    const usageLimits = yield* retainUsageLimits(lastKnown, snapshot.usageLimits);
    if (usageLimits === snapshot.usageLimits) return snapshot;
    return usageLimits ? { ...snapshot, usageLimits } : snapshot;
  });
}
