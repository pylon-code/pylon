import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  authenticatedUsageIdentity,
  isRetainedUsageFresh,
  matchingAccountUsage,
  retainSnapshotUsageLimits,
  retainUsageLimitsForAccount,
  preferFreshUsageReading,
  usageReadingForAuth,
  type AccountUsageReading,
} from "./providerUsageRetention.ts";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");

const usage = (checkedAt: string): ServerProviderUsageLimits => ({
  source: "claudeOAuth",
  checkedAt,
  windows: [{ label: "Session", usedPercent: 20 }],
});

describe("direct reset readings", () => {
  const auth = { status: "authenticated" as const };
  it("keeps the direct read when a pre-reset probe returns late", () => {
    const before = { auth, usageLimits: usage("2026-08-06T11:50:00.000Z") };
    const reset = { ...usage("2026-08-06T11:59:00.000Z"), resetCredits: { availableCount: 0 } };
    assert.strictEqual(preferFreshUsageReading(before, reset, NOW).usageLimits, reset);
  });
  it("accepts a genuinely newer probe", () => {
    const current = { auth, usageLimits: usage("2026-08-06T12:00:00.000Z") };
    assert.strictEqual(
      preferFreshUsageReading(current, usage("2026-08-06T11:59:00.000Z"), NOW),
      current,
    );
  });
  it("does not retain reset data after sign-out or past its age bound", () => {
    const signedOut = { auth: { status: "unauthenticated" as const } };
    assert.strictEqual(
      preferFreshUsageReading(signedOut, usage("2026-08-06T11:59:00.000Z"), NOW),
      signedOut,
    );
    const pending = { auth };
    assert.strictEqual(
      preferFreshUsageReading(pending, usage("2026-08-06T11:00:00.000Z"), NOW),
      pending,
    );
    assert.strictEqual(
      preferFreshUsageReading(pending, usage("2026-08-06T13:00:00.000Z"), NOW),
      pending,
    );
  });
});

describe("isRetainedUsageFresh", () => {
  it("keeps a recent reading", () => {
    assert.isTrue(isRetainedUsageFresh({ checkedAt: "2026-08-06T11:50:00.000Z", nowMs: NOW }));
  });

  // Past the bound the number stops being useful and starts being misleading.
  it("drops a reading older than the retention bound", () => {
    assert.isFalse(isRetainedUsageFresh({ checkedAt: "2026-08-06T11:00:00.000Z", nowMs: NOW }));
  });

  // A clock skewed into the future is not evidence of freshness.
  it("refuses a reading stamped in the future", () => {
    assert.isFalse(isRetainedUsageFresh({ checkedAt: "2026-08-06T13:00:00.000Z", nowMs: NOW }));
  });

  it("refuses an unparseable timestamp", () => {
    assert.isFalse(isRetainedUsageFresh({ checkedAt: "not a date", nowMs: NOW }));
  });
});

const ACCOUNT_A = "email:a@example.com";
const ACCOUNT_B = "email:b@example.com";

it("binds an authenticated Codex reading to both account id and live email", () => {
  assert.strictEqual(
    authenticatedUsageIdentity({
      status: "authenticated",
      accountId: "account-1",
      email: "A@Example.com",
    }),
    "account:account-1|email:a@example.com",
  );
  assert.isUndefined(authenticatedUsageIdentity({ status: "unknown", email: "a@example.com" }));
});

it("does not overlay a direct reset reading onto another or unverified account", () => {
  const direct = { identity: ACCOUNT_A, usageLimits: usage("2026-08-06T11:59:00.000Z") };
  assert.strictEqual(
    usageReadingForAuth(direct, { status: "authenticated", email: "a@example.com" }),
    direct.usageLimits,
  );
  assert.isUndefined(
    usageReadingForAuth(direct, { status: "authenticated", email: "b@example.com" }),
  );
  assert.isUndefined(usageReadingForAuth(direct, { status: "unknown" }));
});

it("accepts a Claude OAuth read only when its account probe agrees with the current account", () => {
  const limits = usage("2026-08-06T11:59:00.000Z");
  assert.strictEqual(
    matchingAccountUsage("B@Example.com", {
      accountIdentity: "b@example.com",
      usageLimits: limits,
    }),
    limits,
  );
  assert.isUndefined(
    matchingAccountUsage("b@example.com", {
      accountIdentity: "a@example.com",
      usageLimits: limits,
    }),
  );
  assert.isUndefined(
    matchingAccountUsage("b@example.com", { accountIdentity: undefined, usageLimits: limits }),
  );
});

describe("retainUsageLimitsForAccount", () => {
  it.effect("remembers a successful reading", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const lastKnown = yield* Ref.make<AccountUsageReading | undefined>(undefined);
      const fresh = usage("2026-08-06T11:59:00.000Z");

      const result = yield* retainUsageLimitsForAccount(lastKnown, ACCOUNT_A, fresh);

      assert.strictEqual(result, fresh);
      assert.deepStrictEqual(yield* Ref.get(lastKnown), {
        identity: ACCOUNT_A,
        usageLimits: fresh,
      });
    }),
  );

  // The whole point: a rate-limited endpoint must not blank the gauge.
  it.effect("keeps showing the last reading when a probe fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const previous = usage("2026-08-06T11:59:00.000Z");
      const lastKnown = yield* Ref.make<AccountUsageReading | undefined>({
        identity: ACCOUNT_A,
        usageLimits: previous,
      });

      const result = yield* retainUsageLimitsForAccount(lastKnown, ACCOUNT_A, undefined);

      assert.strictEqual(result, previous);
    }),
  );

  it.effect("gives up on a reading that has gone stale", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const ancient = usage("2020-01-01T00:00:00.000Z");
      const lastKnown = yield* Ref.make<AccountUsageReading | undefined>({
        identity: ACCOUNT_A,
        usageLimits: ancient,
      });

      const result = yield* retainUsageLimitsForAccount(lastKnown, ACCOUNT_A, undefined);

      assert.isUndefined(result);
      // Cleared as well, so it cannot resurface later.
      assert.isUndefined(yield* Ref.get(lastKnown));
    }),
  );

  it.effect("has nothing to show before any reading succeeds", () =>
    Effect.gen(function* () {
      const lastKnown = yield* Ref.make<AccountUsageReading | undefined>(undefined);

      assert.isUndefined(yield* retainUsageLimitsForAccount(lastKnown, ACCOUNT_A, undefined));
    }),
  );

  it.effect("clears account A after an authenticated switch to B with a failed read", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const previous = usage("2026-08-06T11:59:00.000Z");
      const lastKnown = yield* Ref.make<AccountUsageReading | undefined>({
        identity: ACCOUNT_A,
        usageLimits: previous,
      });
      assert.isUndefined(yield* retainUsageLimitsForAccount(lastKnown, ACCOUNT_B, undefined));
      assert.isUndefined(yield* Ref.get(lastKnown));
      assert.isUndefined(yield* retainUsageLimitsForAccount(lastKnown, ACCOUNT_A, undefined));
    }),
  );

  it.effect("does not retain an unidentified account's reading", () =>
    Effect.gen(function* () {
      const lastKnown = yield* Ref.make<AccountUsageReading | undefined>(undefined);
      const fresh = usage("2026-08-06T11:59:00.000Z");
      assert.strictEqual(yield* retainUsageLimitsForAccount(lastKnown, undefined, fresh), fresh);
      assert.isUndefined(yield* Ref.get(lastKnown));
    }),
  );

  it.effect("hides an A reading during unknown auth, then reuses it only for verified A", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const previous = usage("2026-08-06T11:59:00.000Z");
      const lastKnown = yield* Ref.make<AccountUsageReading | undefined>({
        identity: ACCOUNT_A,
        usageLimits: previous,
      });
      assert.isUndefined(yield* retainUsageLimitsForAccount(lastKnown, undefined, undefined));
      assert.deepStrictEqual(yield* Ref.get(lastKnown), {
        identity: ACCOUNT_A,
        usageLimits: previous,
      });
      assert.strictEqual(
        yield* retainUsageLimitsForAccount(lastKnown, ACCOUNT_A, undefined),
        previous,
      );
      assert.isUndefined(yield* retainUsageLimitsForAccount(lastKnown, ACCOUNT_B, undefined));
    }),
  );
});

describe("retainSnapshotUsageLimits", () => {
  const snapshot = (input: {
    readonly auth: "authenticated" | "unauthenticated" | "unknown";
    readonly email?: string;
    readonly usageLimits?: ServerProviderUsageLimits;
  }) => ({
    auth: { status: input.auth, ...(input.email ? { email: input.email } : {}) },
    ...(input.usageLimits ? { usageLimits: input.usageLimits } : {}),
  });

  // Codex reads its windows over the network inside the status probe; one
  // slow answer must not blank a gauge the previous probe filled.
  it.effect("carries the last reading onto a probe that lost it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const previous = usage("2026-08-06T11:59:00.000Z");
      const lastKnown = yield* Ref.make<AccountUsageReading | undefined>({
        identity: ACCOUNT_A,
        usageLimits: previous,
      });

      const result = yield* retainSnapshotUsageLimits(
        lastKnown,
        snapshot({ auth: "authenticated", email: "a@example.com" }),
      );

      assert.strictEqual(result.usageLimits, previous);
    }),
  );

  it.effect("returns the probe untouched when it carries its own reading", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const lastKnown = yield* Ref.make<AccountUsageReading | undefined>(undefined);
      const probed = snapshot({
        auth: "authenticated",
        email: "a@example.com",
        usageLimits: usage("2026-08-06T11:59:00.000Z"),
      });

      const result = yield* retainSnapshotUsageLimits(lastKnown, probed);

      assert.strictEqual(result, probed);
      assert.deepStrictEqual(yield* Ref.get(lastKnown), {
        identity: ACCOUNT_A,
        usageLimits: probed.usageLimits,
      });
    }),
  );

  // A signed-out account has no capacity; showing the old number would say
  // the opposite of what the probe just found.
  it.effect("clears the reading when the account signs out", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const lastKnown = yield* Ref.make<AccountUsageReading | undefined>({
        identity: ACCOUNT_A,
        usageLimits: usage("2026-08-06T11:59:00.000Z"),
      });

      const result = yield* retainSnapshotUsageLimits(
        lastKnown,
        snapshot({ auth: "unauthenticated", usageLimits: usage("2026-08-06T11:59:30.000Z") }),
      );

      assert.strictEqual(result.usageLimits, undefined);
      assert.strictEqual(yield* Ref.get(lastKnown), undefined);
    }),
  );

  it.effect("does not attach account A's reading to an authenticated B snapshot", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const lastKnown = yield* Ref.make<AccountUsageReading | undefined>({
        identity: ACCOUNT_A,
        usageLimits: usage("2026-08-06T11:59:00.000Z"),
      });
      const result = yield* retainSnapshotUsageLimits(
        lastKnown,
        snapshot({ auth: "authenticated", email: "b@example.com" }),
      );
      assert.isUndefined(result.usageLimits);
      assert.isUndefined(yield* Ref.get(lastKnown));
    }),
  );
});
