import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import {
  acquireSharedUsageLock,
  decideSharedUsageRead,
  defaultSharedUsageCacheDir,
  markSharedUsageReadFailed,
  readSharedUsageEntry,
  releaseSharedUsageLock,
  SHARED_USAGE_BUSY_RETRY_MS,
  SHARED_USAGE_FAILURE_BACKOFF_MS,
  SHARED_USAGE_LOCK_STALE_MS,
  sharedUsageReadKey,
  writeSharedUsageEntry,
} from "./sharedUsageReadCache.ts";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const at = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + offsetMs));

const usage = (checkedAt: string): ServerProviderUsageLimits => ({
  source: "claudeOAuth",
  checkedAt,
  windows: [{ label: "Session", usedPercent: 20, windowDurationMins: 300 }],
});

describe("decideSharedUsageRead", () => {
  // The caller is told exactly how long the reading has left, so every server
  // on the machine comes back to the shared file together.
  it("serves a fresh reading for the rest of its window", () => {
    const decision = decideSharedUsageRead(
      { version: 1, readAt: at(-2 * 60_000), usageLimits: usage(at(-2 * 60_000)) },
      NOW,
    );

    assert.strictEqual(decision.kind, "fresh");
    assert.strictEqual(decision.kind === "fresh" && decision.cacheForMs, 3 * 60_000);
  });

  // A loser of the read race, or a reading with seconds left, checks back
  // shortly rather than immediately.
  it("never hands out a window shorter than the retry floor", () => {
    const decision = decideSharedUsageRead(
      { version: 1, readAt: at(-(5 * 60_000 - 10_000)), usageLimits: usage(at(0)) },
      NOW,
    );

    assert.strictEqual(
      decision.kind === "fresh" && decision.cacheForMs,
      SHARED_USAGE_BUSY_RETRY_MS,
    );
  });

  it("asks for a read once the window has passed", () => {
    assert.strictEqual(
      decideSharedUsageRead(
        { version: 1, readAt: at(-6 * 60_000), usageLimits: usage(at(-6 * 60_000)) },
        NOW,
      ).kind,
      "read",
    );
  });

  // A 429 written by one process keeps every other process away too.
  it("honours a throttle in force, even over a fresh reading", () => {
    const decision = decideSharedUsageRead(
      {
        version: 1,
        readAt: at(-60_000),
        usageLimits: usage(at(-60_000)),
        throttledUntil: at(4 * 60_000),
      },
      NOW,
    );

    assert.deepStrictEqual(decision, { kind: "throttled", cacheForMs: 4 * 60_000 });
  });

  it("reads again once a throttle has expired", () => {
    assert.strictEqual(
      decideSharedUsageRead({ version: 1, readAt: at(-10 * 60_000), throttledUntil: at(-1) }, NOW)
        .kind,
      "read",
    );
  });

  it("shares a short failure backoff while retaining the last good reading", () => {
    const retained = usage(at(-10 * 60_000));
    assert.deepStrictEqual(
      decideSharedUsageRead(
        {
          version: 1,
          readAt: at(-10 * 60_000),
          usageLimits: retained,
          failedAt: at(-10_000),
        },
        NOW,
      ),
      {
        kind: "backoff",
        usageLimits: retained,
        cacheForMs: SHARED_USAGE_FAILURE_BACKOFF_MS - 10_000,
      },
    );
    assert.strictEqual(
      decideSharedUsageRead(
        { version: 1, readAt: at(-10 * 60_000), failedAt: at(-SHARED_USAGE_FAILURE_BACKOFF_MS) },
        NOW,
      ).kind,
      "read",
    );
  });

  it("serves a normally fresh reading despite a failure in a shorter request window", () => {
    assert.strictEqual(
      decideSharedUsageRead(
        {
          version: 1,
          readAt: at(-2 * 60_000),
          usageLimits: usage(at(-2 * 60_000)),
          failedAt: at(-10_000),
        },
        NOW,
      ).kind,
      "fresh",
    );
  });

  it.each([
    ["no entry", undefined],
    ["an entry with nothing in it", { version: 1 as const, readAt: at(-1000) }],
    [
      "a reading from the future",
      { version: 1 as const, readAt: at(60_000), usageLimits: usage(at(0)) },
    ],
    [
      "an unreadable timestamp",
      { version: 1 as const, readAt: "nonsense", usageLimits: usage(at(0)) },
    ],
  ])("reads when there is %s", (_label, entry) => {
    assert.strictEqual(decideSharedUsageRead(entry, NOW).kind, "read");
  });
});

describe("sharedUsageReadKey", () => {
  it("is stable for the same account and distinct across accounts", () => {
    assert.strictEqual(
      sharedUsageReadKey(["claude", "/Users/a/.claude"]),
      sharedUsageReadKey(["claude", "/Users/a/.claude"]),
    );
    assert.notStrictEqual(
      sharedUsageReadKey(["claude", "/Users/a/.claude"]),
      sharedUsageReadKey(["claude", "/Users/a/.claude_work"]),
    );
  });
});

it.layer(NodeServices.layer)("shared usage read cache", (it) => {
  // Never the runtime home: a dev server with its own `.t3` must still find
  // the installed app's reading.
  it.effect("resolves the machine cache directory per platform", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = "/Users/someone";
      assert.strictEqual(
        defaultSharedUsageCacheDir({ platform: "darwin", env: {}, homeDir: home, path }),
        "/Users/someone/Library/Caches/pylon-code/usage",
      );
      assert.strictEqual(
        defaultSharedUsageCacheDir({ platform: "linux", env: {}, homeDir: home, path }),
        "/Users/someone/.cache/pylon-code/usage",
      );
      assert.strictEqual(
        defaultSharedUsageCacheDir({
          platform: "linux",
          env: { XDG_CACHE_HOME: "/tmp/xdg" },
          homeDir: home,
          path,
        }),
        "/tmp/xdg/pylon-code/usage",
      );
      assert.strictEqual(
        defaultSharedUsageCacheDir({
          platform: "darwin",
          env: { PYLON_USAGE_CACHE_DIR: "/tmp/pylon-test-usage" },
          homeDir: home,
          path,
        }),
        "/tmp/pylon-test-usage",
      );
    }),
  );

  it.effect("round-trips an entry and tolerates a corrupt one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-usage-cache-" });
      const key = sharedUsageReadKey(["claude", "/test"]);
      const entry = { version: 1 as const, readAt: at(0), usageLimits: usage(at(0)) };

      assert.strictEqual(yield* readSharedUsageEntry(dir, key), undefined);
      yield* writeSharedUsageEntry(dir, key, entry);
      assert.deepStrictEqual(yield* readSharedUsageEntry(dir, key), entry);

      yield* markSharedUsageReadFailed(dir, key, at(1000));
      assert.deepStrictEqual(yield* readSharedUsageEntry(dir, key), {
        ...entry,
        failedAt: at(1000),
      });

      yield* fs.writeFileString(path.join(dir, `${key}.json`), "{not json");
      assert.strictEqual(yield* readSharedUsageEntry(dir, key), undefined);
    }).pipe(Effect.scoped),
  );

  it.effect("cold-misses mismatched revisions and rejects a retired write", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-usage-fence-" });
      const key = sharedUsageReadKey(["prime", "primeAgent", "anthropic", "revision-b"]);
      const current = yield* Ref.make(true);
      const entry = {
        version: 1 as const,
        configRevision: "revision-b",
        readAt: at(0),
        usageLimits: usage(at(0)),
      };
      yield* writeSharedUsageEntry(dir, key, entry, Ref.get(current));
      yield* Ref.set(current, false);
      yield* writeSharedUsageEntry(
        dir,
        key,
        { ...entry, configRevision: "revision-a", readAt: at(1_000) },
        Ref.get(current),
      );

      assert.deepStrictEqual(yield* readSharedUsageEntry(dir, key, "revision-b"), entry);
      assert.strictEqual(yield* readSharedUsageEntry(dir, key, "revision-a"), undefined);
    }).pipe(Effect.scoped),
  );

  // Several servers expiring together must read the endpoint once.
  it.effect("hands the lock to one holder at a time and breaks a dead one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-usage-lock-" });
      const key = sharedUsageReadKey(["claude", "/test"]);

      assert.isTrue(yield* acquireSharedUsageLock(dir, key, NOW));
      assert.isFalse(yield* acquireSharedUsageLock(dir, key, NOW + 1000));
      yield* releaseSharedUsageLock(dir, key);
      assert.isTrue(yield* acquireSharedUsageLock(dir, key, NOW + 2000));

      // A lock older than the stale bound belongs to a process that died
      // mid-read; the next reader takes it over.
      assert.isFalse(yield* acquireSharedUsageLock(dir, key, NOW + SHARED_USAGE_LOCK_STALE_MS));
      assert.isTrue(
        yield* acquireSharedUsageLock(dir, key, NOW + 2000 + SHARED_USAGE_LOCK_STALE_MS + 1),
      );

      // So does one this build cannot read.
      yield* fs.writeFileString(path.join(dir, `${key}.lock`), "???");
      assert.isTrue(yield* acquireSharedUsageLock(dir, key, NOW));
      yield* releaseSharedUsageLock(dir, key);
    }).pipe(Effect.scoped),
  );
});
