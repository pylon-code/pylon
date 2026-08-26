import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  isRetainedUsageFresh,
  retainSnapshotUsageLimits,
  retainUsageLimits,
} from "./providerUsageRetention.ts";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");

const usage = (checkedAt: string): ServerProviderUsageLimits => ({
  source: "claudeOAuth",
  checkedAt,
  windows: [{ label: "Session", usedPercent: 20 }],
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

describe("retainUsageLimits", () => {
  it.effect("remembers a successful reading", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const lastKnown = yield* Ref.make<ServerProviderUsageLimits | undefined>(undefined);
      const fresh = usage("2026-08-06T11:59:00.000Z");

      const result = yield* retainUsageLimits(lastKnown, fresh);

      assert.strictEqual(result, fresh);
      assert.strictEqual(yield* Ref.get(lastKnown), fresh);
    }),
  );

  // The whole point: a rate-limited endpoint must not blank the gauge.
  it.effect("keeps showing the last reading when a probe fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const previous = usage("2026-08-06T11:59:00.000Z");
      const lastKnown = yield* Ref.make<ServerProviderUsageLimits | undefined>(previous);

      const result = yield* retainUsageLimits(lastKnown, undefined);

      assert.strictEqual(result, previous);
    }),
  );

  it.effect("gives up on a reading that has gone stale", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const ancient = usage("2020-01-01T00:00:00.000Z");
      const lastKnown = yield* Ref.make<ServerProviderUsageLimits | undefined>(ancient);

      const result = yield* retainUsageLimits(lastKnown, undefined);

      assert.isUndefined(result);
      // Cleared as well, so it cannot resurface later.
      assert.isUndefined(yield* Ref.get(lastKnown));
    }),
  );

  it.effect("has nothing to show before any reading succeeds", () =>
    Effect.gen(function* () {
      const lastKnown = yield* Ref.make<ServerProviderUsageLimits | undefined>(undefined);

      assert.isUndefined(yield* retainUsageLimits(lastKnown, undefined));
    }),
  );
});

describe("retainSnapshotUsageLimits", () => {
  const snapshot = (input: {
    readonly auth: "authenticated" | "unauthenticated" | "unknown";
    readonly usageLimits?: ServerProviderUsageLimits;
  }) => ({
    auth: { status: input.auth },
    ...(input.usageLimits ? { usageLimits: input.usageLimits } : {}),
  });

  // Codex reads its windows over the network inside the status probe; one
  // slow answer must not blank a gauge the previous probe filled.
  it.effect("carries the last reading onto a probe that lost it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const previous = usage("2026-08-06T11:59:00.000Z");
      const lastKnown = yield* Ref.make<ServerProviderUsageLimits | undefined>(previous);

      const result = yield* retainSnapshotUsageLimits(
        lastKnown,
        snapshot({ auth: "authenticated" }),
      );

      assert.strictEqual(result.usageLimits, previous);
    }),
  );

  it.effect("returns the probe untouched when it carries its own reading", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const lastKnown = yield* Ref.make<ServerProviderUsageLimits | undefined>(undefined);
      const probed = snapshot({
        auth: "authenticated",
        usageLimits: usage("2026-08-06T11:59:00.000Z"),
      });

      const result = yield* retainSnapshotUsageLimits(lastKnown, probed);

      assert.strictEqual(result, probed);
      assert.strictEqual(yield* Ref.get(lastKnown), probed.usageLimits);
    }),
  );

  // A signed-out account has no capacity; showing the old number would say
  // the opposite of what the probe just found.
  it.effect("clears the reading when the account signs out", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const lastKnown = yield* Ref.make<ServerProviderUsageLimits | undefined>(
        usage("2026-08-06T11:59:00.000Z"),
      );

      const result = yield* retainSnapshotUsageLimits(
        lastKnown,
        snapshot({ auth: "unauthenticated", usageLimits: usage("2026-08-06T11:59:30.000Z") }),
      );

      assert.strictEqual(result.usageLimits, undefined);
      assert.strictEqual(yield* Ref.get(lastKnown), undefined);
    }),
  );
});
