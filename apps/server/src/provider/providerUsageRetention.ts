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

/** A direct reset read wins over an older probe or cached response, within the normal retention bound. */
export function preferFreshUsageReading<
  Snapshot extends {
    readonly auth: ServerProviderAuth;
    readonly usageLimits?: ServerProviderUsageLimits | undefined;
  },
>(snapshot: Snapshot, reading: ServerProviderUsageLimits | undefined, nowMs: number): Snapshot {
  if (
    !reading ||
    snapshot.auth.status === "unauthenticated" ||
    !isRetainedUsageFresh({ checkedAt: reading.checkedAt, nowMs }) ||
    (snapshot.usageLimits &&
      Date.parse(snapshot.usageLimits.checkedAt) >= Date.parse(reading.checkedAt))
  ) {
    return snapshot;
  }
  return { ...snapshot, usageLimits: reading };
}

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
export interface AccountUsageReading {
  readonly identity: string;
  readonly usageLimits: ServerProviderUsageLimits;
}

/** Only stable, affirmative account identity can authorize a retained reading. */
export function authenticatedUsageIdentity(auth: ServerProviderAuth): string | undefined {
  if (auth.status !== "authenticated") return undefined;
  // Account id and live CLI email are independent signals. Keeping both
  // prevents a changing auth.json from assigning B's CLI read to A's id.
  if (auth.accountId && auth.email) {
    return `account:${auth.accountId}|email:${auth.email.trim().toLowerCase()}`;
  }
  if (auth.accountId) return `account:${auth.accountId}`;
  if (auth.email) return `email:${auth.email.trim().toLowerCase()}`;
  return undefined;
}

/** A direct post-reset read may overlay only the same authenticated account. */
export function usageReadingForAuth(
  reading: AccountUsageReading | undefined,
  auth: ServerProviderAuth,
): ServerProviderUsageLimits | undefined {
  const identity = authenticatedUsageIdentity(auth);
  return identity && reading?.identity === identity ? reading.usageLimits : undefined;
}

/** A separate OAuth usage read must agree with the authenticated account. */
export function matchingAccountUsage(
  expectedEmail: string | undefined,
  result:
    | {
        readonly accountIdentity: string | undefined;
        readonly usageLimits: ServerProviderUsageLimits | undefined;
      }
    | undefined,
): ServerProviderUsageLimits | undefined {
  if (!result) return undefined;
  if (
    expectedEmail &&
    result.accountIdentity?.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()
  ) {
    return undefined;
  }
  return result.usageLimits;
}

export function retainUsageLimitsForAccount(
  lastKnown: Ref.Ref<AccountUsageReading | undefined>,
  identity: string | undefined,
  usageLimits: ServerProviderUsageLimits | undefined,
): Effect.Effect<ServerProviderUsageLimits | undefined> {
  return Effect.gen(function* () {
    if (usageLimits) {
      if (identity) yield* RefModule.set(lastKnown, { identity, usageLimits });
      return usageLimits;
    }
    const retained = yield* RefModule.get(lastKnown);
    if (!retained) return undefined;
    // A temporarily unknown auth result cannot authorize publication, but it
    // also cannot prove the signed-in account changed. Hold the reading for a
    // later matching identity without showing it during the unknown interval.
    if (identity === undefined) return undefined;
    if (retained.identity !== identity) {
      yield* RefModule.set(lastKnown, undefined);
      return undefined;
    }
    const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    if (isRetainedUsageFresh({ checkedAt: retained.usageLimits.checkedAt, nowMs })) {
      return retained.usageLimits;
    }
    yield* RefModule.set(lastKnown, undefined);
    return undefined;
  });
}

/**
 * Apply account-scoped retention to a whole probed snapshot.
 *
 * A signed-out account has no capacity to retain. A failed or timed-out read
 * may reuse the last reading only while the authenticated account identity
 * remains the same. Codex reads its windows over the network inside the
 * status probe, where one slow answer would otherwise blank the gauge.
 */
export function retainSnapshotUsageLimits<
  Snapshot extends {
    readonly auth: ServerProviderAuth;
    readonly usageLimits?: ServerProviderUsageLimits | undefined;
  },
>(
  lastKnown: Ref.Ref<AccountUsageReading | undefined>,
  snapshot: Snapshot,
): Effect.Effect<Snapshot> {
  return Effect.gen(function* () {
    if (snapshot.auth.status === "unauthenticated") {
      yield* RefModule.set(lastKnown, undefined);
      const { usageLimits: _usageLimits, ...withoutUsage } = snapshot;
      return withoutUsage as Snapshot;
    }
    const usageLimits = yield* retainUsageLimitsForAccount(
      lastKnown,
      authenticatedUsageIdentity(snapshot.auth),
      snapshot.usageLimits,
    );
    if (usageLimits === snapshot.usageLimits) return snapshot;
    return usageLimits ? { ...snapshot, usageLimits } : snapshot;
  });
}
