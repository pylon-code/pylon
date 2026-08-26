/**
 * One reading of a provider's subscription usage, shared by every Pylon
 * server on the machine.
 *
 * The usage endpoints are rate limited per account, and one machine routinely
 * runs several servers against the same account — the installed app plus a
 * worktree dev server or three. Each has its own in-memory cache, so without
 * this every one of them polls on its own schedule and the account is read N
 * times per window. The cache lives in the user's machine-level cache
 * directory, deliberately outside any runtime home, so servers with different
 * homes still find each other's readings.
 *
 * Three rules keep it honest:
 *
 *  - A reading is served for the rest of its window, and the caller's own
 *    cache is told exactly how long that is, so every server re-reads the
 *    shared file at the same moment rather than each holding a private copy
 *    for a full window on top.
 *  - A 429 is shared too: the process that was told to wait writes the
 *    deadline, and every other process honours it without asking.
 *  - A lock file makes the endpoint read once when several servers expire
 *    together. A process that loses the race serves what is there and checks
 *    back shortly rather than queueing behind the winner.
 *
 * Every filesystem failure degrades to "no shared reading": the caller falls
 * through to its own read, which is exactly what happened before this existed.
 *
 * @module provider/sharedUsageReadCache
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

/** How long one reading stands in for the account, machine-wide. */
export const SHARED_USAGE_READ_TTL_MS = 5 * 60_000;
/** A process that loses the read race checks back after this long. */
export const SHARED_USAGE_BUSY_RETRY_MS = 30_000;
/** A lock older than this belongs to a process that died mid-read. */
export const SHARED_USAGE_LOCK_STALE_MS = 30_000;
/** Overrides the machine cache directory; mainly for isolated test environments. */
export const SHARED_USAGE_CACHE_DIR_ENV = "PYLON_USAGE_CACHE_DIR";

export const SharedUsageReadEntry = Schema.Struct({
  version: Schema.Literal(1),
  /** When the endpoint was actually read. */
  readAt: Schema.String,
  usageLimits: Schema.optional(ServerProviderUsageLimits),
  /** Set by whichever process was told to back off; honoured by all. */
  throttledUntil: Schema.optional(Schema.String),
});
export type SharedUsageReadEntry = typeof SharedUsageReadEntry.Type;

const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(SharedUsageReadEntry));
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(SharedUsageReadEntry));

/** Who holds the read lock and since when, by the holder's own clock. */
const SharedUsageLock = Schema.Struct({ pid: Schema.Number, at: Schema.Number });
const decodeLock = Schema.decodeUnknownOption(Schema.fromJsonString(SharedUsageLock));
const encodeLock = Schema.encodeSync(Schema.fromJsonString(SharedUsageLock));

export type SharedUsageReadDecision =
  | {
      readonly kind: "fresh";
      readonly usageLimits: ServerProviderUsageLimits;
      /** How long the caller may serve this before checking the shared file again. */
      readonly cacheForMs: number;
    }
  | { readonly kind: "throttled"; readonly cacheForMs: number }
  | { readonly kind: "read" };

function parseMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * What a shared entry means right now. A throttle in force wins over a
 * reading: the endpoint has asked for room, and a number that is still fresh
 * is served by the caller's retained reading anyway.
 */
export function decideSharedUsageRead(
  entry: SharedUsageReadEntry | undefined,
  nowMs: number,
  ttlMs: number = SHARED_USAGE_READ_TTL_MS,
): SharedUsageReadDecision {
  if (!entry) return { kind: "read" };
  const throttledUntilMs = parseMs(entry.throttledUntil);
  if (throttledUntilMs !== undefined && throttledUntilMs > nowMs) {
    return { kind: "throttled", cacheForMs: Math.max(60_000, throttledUntilMs - nowMs) };
  }
  const readAtMs = parseMs(entry.readAt);
  if (entry.usageLimits && readAtMs !== undefined) {
    const age = nowMs - readAtMs;
    if (age >= 0 && age < ttlMs) {
      return {
        kind: "fresh",
        usageLimits: entry.usageLimits,
        cacheForMs: Math.max(SHARED_USAGE_BUSY_RETRY_MS, ttlMs - age),
      };
    }
  }
  return { kind: "read" };
}

/** Stable file name for one account, from the parts that identify it. */
export function sharedUsageReadKey(parts: ReadonlyArray<string>): string {
  return NodeCrypto.createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 24);
}

/**
 * The machine-level cache directory for this user: `~/Library/Caches` on
 * macOS, `%LOCALAPPDATA%` on Windows, `$XDG_CACHE_HOME` (or `~/.cache`)
 * elsewhere. Never the runtime home — that is the whole point.
 */
export function defaultSharedUsageCacheDir(input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly path: Path.Path;
}): string {
  const override = input.env[SHARED_USAGE_CACHE_DIR_ENV]?.trim();
  if (override) return override;
  const { path, homeDir } = input;
  switch (input.platform) {
    case "darwin":
      return path.join(homeDir, "Library", "Caches", "pylon-code", "usage");
    case "win32": {
      const localAppData = input.env.LOCALAPPDATA?.trim();
      return path.join(
        localAppData || path.join(homeDir, "AppData", "Local"),
        "pylon-code",
        "Cache",
        "usage",
      );
    }
    default: {
      const xdgCache = input.env.XDG_CACHE_HOME?.trim();
      return path.join(xdgCache || path.join(homeDir, ".cache"), "pylon-code", "usage");
    }
  }
}

export const resolveSharedUsageCacheDir: Effect.Effect<string, never, Path.Path> = Effect.gen(
  function* () {
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    return defaultSharedUsageCacheDir({
      platform,
      env: process.env,
      homeDir: NodeOS.homedir(),
      path,
    });
  },
);

const entryPath = (path: Path.Path, dir: string, key: string) => path.join(dir, `${key}.json`);
const lockPath = (path: Path.Path, dir: string, key: string) => path.join(dir, `${key}.lock`);

export const readSharedUsageEntry = Effect.fn("readSharedUsageEntry")(function* (
  dir: string,
  key: string,
): Effect.fn.Return<SharedUsageReadEntry | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fileSystem.readFileString(entryPath(path, dir, key)).pipe(
    Effect.map(Option.some),
    Effect.catchCause(() => Effect.succeed(Option.none<string>())),
  );
  if (Option.isNone(raw)) return undefined;
  return Option.getOrUndefined(decodeEntry(raw.value));
});

/**
 * Written through a sibling temp file and a rename, so a reader never sees
 * half an entry. Failure is ignored: the reading still served this process,
 * it just will not be shared.
 */
export const writeSharedUsageEntry = Effect.fn("writeSharedUsageEntry")(function* (
  dir: string,
  key: string,
  entry: SharedUsageReadEntry,
): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = entryPath(path, dir, key);
  const temp = `${target}.${process.pid}.tmp`;
  yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(dir, { recursive: true });
    yield* fileSystem.writeFileString(temp, encodeEntry(entry));
    yield* fileSystem.rename(temp, target);
  }).pipe(Effect.catchCause(() => Effect.void));
});

/**
 * Claim the right to read the endpoint for this account. `true` means this
 * process should read and then release; `false` means another process is
 * reading right now and its result will land in the shared file shortly.
 *
 * The lock is a file created exclusively, carrying the holder's clock. One
 * left behind by a process that died mid-read is broken once it is older
 * than `SHARED_USAGE_LOCK_STALE_MS`; an unreadable lock counts as dead.
 */
export const acquireSharedUsageLock = Effect.fn("acquireSharedUsageLock")(function* (
  dir: string,
  key: string,
  nowMs: number,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = lockPath(path, dir, key);
  const tryCreate = fileSystem
    .writeFileString(lock, encodeLock({ pid: process.pid, at: nowMs }), { flag: "wx" })
    .pipe(
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    );

  yield* fileSystem.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore);
  if (yield* tryCreate) return true;

  const heldSince = yield* fileSystem.readFileString(lock).pipe(
    Effect.map((raw) => Option.map(decodeLock(raw), (held) => held.at)),
    Effect.catchCause(() => Effect.succeed(Option.none<number>())),
  );
  const stale = Option.match(heldSince, {
    onNone: () => true,
    onSome: (since) => nowMs - since > SHARED_USAGE_LOCK_STALE_MS,
  });
  if (!stale) return false;
  yield* fileSystem.remove(lock).pipe(Effect.ignore);
  return yield* tryCreate;
});

export const releaseSharedUsageLock = Effect.fn("releaseSharedUsageLock")(function* (
  dir: string,
  key: string,
): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.remove(lockPath(path, dir, key)).pipe(Effect.ignore);
});
