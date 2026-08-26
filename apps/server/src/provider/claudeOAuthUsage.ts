/**
 * Reads Claude subscription usage from Anthropic's OAuth usage endpoint.
 *
 * `GET https://api.anthropic.com/api/oauth/usage` returns continuous
 * percentages for every active rate-limit window as JSON — the same data
 * claude.ai's own UI renders. It replaces scraping `claude --print "/usage"`,
 * whose human-readable output has already changed shape twice and fails
 * silently when it does.
 *
 * Two things it is deliberately not:
 *
 *  - **Not a credential writer.** Access tokens are read, never refreshed or
 *    written back. A 401 yields `undefined` and the caller falls back to the
 *    CLI probe, which refreshes as a side effect of running. Pylon needs a
 *    gauge, not a session, so it has no reason to mutate another program's
 *    private credential store.
 *  - **Not a documented API.** `/api/oauth/` is private and unversioned, so
 *    every field is optional and every parse fails closed. Losing a reading is
 *    a blank gauge; throwing would take down the provider probe.
 *
 * @module provider/claudeOAuthUsage
 */
import * as NodeOS from "node:os";

import * as NodeCrypto from "node:crypto";

import type {
  ClaudeSettings,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { resolveProviderHomePath } from "../pathExpansion.ts";
import { spawnAndCollect } from "./providerSnapshot.ts";
import {
  acquireSharedUsageLock,
  decideSharedUsageRead,
  readSharedUsageEntry,
  releaseSharedUsageLock,
  resolveSharedUsageCacheDir,
  SHARED_USAGE_BUSY_RETRY_MS,
  SHARED_USAGE_READ_TTL_MS,
  sharedUsageReadKey,
  writeSharedUsageEntry,
} from "./sharedUsageReadCache.ts";

const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const OAUTH_USAGE_TIMEOUT_MS = 5_000;
const KEYCHAIN_READ_TIMEOUT_MS = 5_000;
const KEYCHAIN_SERVICE = "Claude Code-credentials";

const SESSION_WINDOW_MINS = 5 * 60;
const WEEKLY_WINDOW_MINS = 7 * 24 * 60;

/**
 * Map a resolved config dir to the keychain service Claude Code stores its
 * credentials under.
 *
 * The default `~/.claude` uses the bare service name; every other directory
 * gets an 8-character sha256 suffix of its absolute path. This mirrors Claude
 * Code's own convention, which is what lets a second account configured
 * through `CLAUDE_CONFIG_DIR` be read without prompting.
 */
export function claudeConfigDirKeychainService(
  configDir: string,
  defaultConfigDir: string,
): string {
  if (configDir === defaultConfigDir) return KEYCHAIN_SERVICE;
  const hash = NodeCrypto.createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${hash}`;
}

/**
 * Resolve which config dir an instance authenticates against.
 *
 * Distinct from `resolveClaudeHomePath`, which answers "what do we set
 * `CLAUDE_CONFIG_DIR` to" and returns the home directory for an unset
 * `homePath`. Credentials for that case live in `~/.claude`, not `~`.
 */
export const resolveClaudeCredentialConfigDir = Effect.fn("resolveClaudeCredentialConfigDir")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
  ): Effect.fn.Return<
    { readonly configDir: string; readonly defaultConfigDir: string },
    never,
    Path.Path
  > {
    const path = yield* Path.Path;
    const defaultConfigDir = path.resolve(path.join(NodeOS.homedir(), ".claude"));
    const homePath = config.homePath.trim();
    return {
      configDir: homePath.length > 0 ? resolveProviderHomePath(homePath) : defaultConfigDir,
      defaultConfigDir,
    };
  },
);

function accessTokenFromCredentialsJson(raw: string): string | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof decoded !== "object" || decoded === null) return undefined;
  const oauth = (decoded as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) return undefined;
  const token = (oauth as { accessToken?: unknown }).accessToken;
  return typeof token === "string" && token.trim().length > 0 ? token.trim() : undefined;
}

/**
 * Claude Code writes the keychain value as hex-encoded JSON after `claude
 * login`; older installs stored raw JSON. Accept both.
 */
export function accessTokenFromKeychainValue(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const direct = accessTokenFromCredentialsJson(trimmed);
  if (direct) return direct;
  if (!/^[0-9a-fA-F]+$/u.test(trimmed) || trimmed.length % 2 !== 0) return undefined;
  try {
    return accessTokenFromCredentialsJson(Buffer.from(trimmed, "hex").toString("utf8"));
  } catch {
    return undefined;
  }
}

const readKeychainAccessToken = Effect.fn("readKeychainAccessToken")(function* (
  service: string,
): Effect.fn.Return<string | undefined, never, ChildProcessSpawner.ChildProcessSpawner> {
  const command = ChildProcess.make(
    "/usr/bin/security",
    ["find-generic-password", "-s", service, "-a", NodeOS.userInfo().username, "-w"],
    { stdin: "ignore" as const },
  );
  const result = yield* spawnAndCollect("/usr/bin/security", command).pipe(
    Effect.timeoutOption(KEYCHAIN_READ_TIMEOUT_MS),
    Effect.catchCause(() => Effect.succeed(Option.none())),
  );
  if (Option.isNone(result) || result.value.code !== 0) return undefined;
  return accessTokenFromKeychainValue(result.value.stdout);
});

const readFileAccessToken = Effect.fn("readFileAccessToken")(function* (
  configDir: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fileSystem.readFileString(path.join(configDir, ".credentials.json")).pipe(
    Effect.map(Option.some),
    Effect.catchCause(() => Effect.succeed(Option.none<string>())),
  );
  return Option.isNone(contents) ? undefined : accessTokenFromCredentialsJson(contents.value);
});

/**
 * Read the OAuth access token for one instance's config dir.
 *
 * macOS keeps credentials in the login keychain (already authorized for this
 * user, so no prompt); every other platform uses `.credentials.json` inside
 * the config dir. The keychain read is tried first and falls through to the
 * file so a macOS install that predates keychain storage still works.
 */
export const readClaudeAccessToken = Effect.fn("readClaudeAccessToken")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<
  string | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const { configDir, defaultConfigDir } = yield* resolveClaudeCredentialConfigDir(config);
  if ((yield* HostProcessPlatform) === "darwin") {
    const service = claudeConfigDirKeychainService(configDir, defaultConfigDir);
    const keychainToken = yield* readKeychainAccessToken(service);
    if (keychainToken) return keychainToken;
  }
  return yield* readFileAccessToken(configDir);
});

interface RawOAuthWindow {
  readonly utilization?: unknown;
  readonly resets_at?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function usedPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  // The endpoint reports 0..100, matching the contract's own scale.
  return Math.max(0, Math.min(100, value));
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function windowFrom(
  raw: unknown,
  label: string,
  windowDurationMins: number,
): ServerProviderUsageWindow | undefined {
  const record = asRecord(raw) as RawOAuthWindow | undefined;
  if (!record) return undefined;
  const percent = usedPercent(record.utilization);
  if (percent === undefined) return undefined;
  const resetsAt = isoTimestamp(record.resets_at);
  return { label, usedPercent: percent, windowDurationMins, ...(resetsAt ? { resetsAt } : {}) };
}

/**
 * Label a `weekly_scoped` entry by the model it covers.
 *
 * Model-scoped weeklies arrive only through `limits[]` — the top-level
 * `seven_day_opus` / `seven_day_sonnet` keys are null even when a scoped limit
 * is active — so this is the only path that surfaces them.
 */
function scopedWeeklyLabel(limit: Record<string, unknown>): string | undefined {
  if (limit["kind"] !== "weekly_scoped") return undefined;
  const model = asRecord(asRecord(limit["scope"])?.["model"]);
  const name = model?.["display_name"] ?? model?.["id"];
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed.length > 0 ? `Weekly (${trimmed})` : undefined;
}

/**
 * Project the endpoint's payload onto the shared usage contract.
 *
 * Labels match what the CLI-scraping parser produced so the popover reads the
 * same regardless of which source served it.
 */
export function usageLimitsFromClaudeOAuthResponse(
  payload: unknown,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  const raw = asRecord(payload);
  if (!raw) return undefined;

  const windows: ServerProviderUsageWindow[] = [];
  const session = windowFrom(raw["five_hour"], "Session", SESSION_WINDOW_MINS);
  if (session) windows.push(session);
  const weekly = windowFrom(raw["seven_day"], "Weekly (all models)", WEEKLY_WINDOW_MINS);
  if (weekly) windows.push(weekly);

  const seen = new Set(windows.map((window) => window.label));
  const limits = raw["limits"];
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      const limit = asRecord(entry);
      if (!limit) continue;
      const label = scopedWeeklyLabel(limit);
      if (!label || seen.has(label)) continue;
      const percent = usedPercent(limit["percent"]);
      if (percent === undefined) continue;
      const resetsAt = isoTimestamp(limit["resets_at"]);
      windows.push({
        label,
        usedPercent: percent,
        windowDurationMins: WEEKLY_WINDOW_MINS,
        ...(resetsAt ? { resetsAt } : {}),
      });
      seen.add(label);
    }
  }

  return windows.length > 0 ? { source: "claudeOAuth", checkedAt, windows } : undefined;
}

/**
 * How long to stay away from the endpoint after it answered 429.
 *
 * `Retry-After` is honoured when present, as seconds or an HTTP date, and
 * bounded: never under a minute, so a burst of retries cannot itself keep the
 * limit tripped, and never over half an hour, past which the retained reading
 * has expired and a fresh attempt is worth more than obedience. Without the
 * header the wait matches the normal poll, so a throttled account is retried
 * no faster than a healthy one would be read.
 */
export const OAUTH_USAGE_THROTTLE_DEFAULT_MS = 5 * 60_000;
export const OAUTH_USAGE_THROTTLE_MIN_MS = 60_000;
export const OAUTH_USAGE_THROTTLE_MAX_MS = 30 * 60_000;

export function throttleDelayFromRetryAfter(retryAfter: string | undefined, nowMs: number): number {
  const clamp = (value: number) =>
    Math.max(OAUTH_USAGE_THROTTLE_MIN_MS, Math.min(OAUTH_USAGE_THROTTLE_MAX_MS, value));
  const trimmed = retryAfter?.trim();
  if (!trimmed) return OAUTH_USAGE_THROTTLE_DEFAULT_MS;
  if (/^\d+$/u.test(trimmed)) return clamp(Number(trimmed) * 1000);
  const atMs = Date.parse(trimmed);
  if (!Number.isFinite(atMs)) return OAUTH_USAGE_THROTTLE_DEFAULT_MS;
  return clamp(atMs - nowMs);
}

/**
 * One read of the endpoint. `usageLimits` is absent when it could not be
 * read — no token, an expired one, an unreachable endpoint, or a payload this
 * build does not recognize. `cacheForMs` tells the caller how long this
 * answer stands: the rest of a shared reading's window, the wait a 429 asked
 * for, or a short retry when another process is mid-read. Absent, the caller
 * uses its usual failure cadence.
 */
export interface ClaudeOAuthUsageRead {
  readonly usageLimits: ServerProviderUsageLimits | undefined;
  readonly cacheForMs?: number | undefined;
}

const NOT_READ: ClaudeOAuthUsageRead = { usageLimits: undefined };

/**
 * Fetch usage for one configured instance, going through the machine-wide
 * shared reading first so several servers on one account read the endpoint
 * once per window between them. Every failure is a caller's cue to fall back
 * to the last retained reading rather than an error to propagate.
 */
export const fetchClaudeOAuthUsage = Effect.fn("fetchClaudeOAuthUsage")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  checkedAt: string,
  options?: { readonly sharedCacheDir?: string | undefined },
): Effect.fn.Return<
  ClaudeOAuthUsageRead,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> {
  const token = yield* readClaudeAccessToken(config);
  if (!token) return NOT_READ;

  const { configDir } = yield* resolveClaudeCredentialConfigDir(config);
  const cacheDir = options?.sharedCacheDir ?? (yield* resolveSharedUsageCacheDir);
  const cacheKey = sharedUsageReadKey(["claude", configDir]);
  const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
  const shared = decideSharedUsageRead(yield* readSharedUsageEntry(cacheDir, cacheKey), nowMs);
  if (shared.kind === "fresh") {
    return { usageLimits: shared.usageLimits, cacheForMs: shared.cacheForMs };
  }
  if (shared.kind === "throttled") {
    return { usageLimits: undefined, cacheForMs: shared.cacheForMs };
  }

  if (!(yield* acquireSharedUsageLock(cacheDir, cacheKey, nowMs))) {
    // Another server is reading this account right now; its answer lands in
    // the shared file shortly. Serve what is there and check back soon.
    const existing = yield* readSharedUsageEntry(cacheDir, cacheKey);
    return { usageLimits: existing?.usageLimits, cacheForMs: SHARED_USAGE_BUSY_RETRY_MS };
  }

  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(OAUTH_USAGE_URL).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
      HttpClientRequest.setHeader("anthropic-beta", OAUTH_BETA_HEADER),
      HttpClientRequest.setHeader("accept", "application/json"),
    );
    const response = yield* client.execute(request).pipe(
      Effect.timeoutOption(OAUTH_USAGE_TIMEOUT_MS),
      Effect.catchCause(() => Effect.succeed(Option.none())),
    );
    if (Option.isNone(response)) return NOT_READ;
    if (response.value.status === 429) {
      const throttledForMs = throttleDelayFromRetryAfter(
        response.value.headers["retry-after"],
        nowMs,
      );
      yield* writeSharedUsageEntry(cacheDir, cacheKey, {
        version: 1,
        readAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        throttledUntil: DateTime.formatIso(DateTime.makeUnsafe(nowMs + throttledForMs)),
      });
      return { usageLimits: undefined, cacheForMs: throttledForMs };
    }
    if (response.value.status < 200 || response.value.status >= 300) return NOT_READ;

    const payload = yield* response.value.json.pipe(
      Effect.map(Option.some),
      Effect.catchCause(() => Effect.succeed(Option.none<unknown>())),
    );
    if (Option.isNone(payload)) return NOT_READ;
    const usageLimits = usageLimitsFromClaudeOAuthResponse(payload.value, checkedAt);
    if (!usageLimits) return NOT_READ;
    yield* writeSharedUsageEntry(cacheDir, cacheKey, {
      version: 1,
      readAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      usageLimits,
    });
    return { usageLimits, cacheForMs: SHARED_USAGE_READ_TTL_MS };
  }).pipe(Effect.ensuring(releaseSharedUsageLock(cacheDir, cacheKey)));
});
