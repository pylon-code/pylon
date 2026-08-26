/**
 * What Prime Agent is signed in to, per backend.
 *
 * Prime runs models on Anthropic or OpenAI Codex with credentials of its own,
 * kept in its agent home's `auth.json`. Pylon has no capacity reading for
 * Prime itself, so the composer shows the capacity of whichever configured
 * account Prime is using — and that is only honest if it is known to be the
 * same account. This module reads what makes that knowable:
 *
 *  - For OpenAI Codex, the ChatGPT account id, which a configured Codex
 *    instance also reports (`auth.accountId`) — equal ids mean one
 *    subscription — and, while the token is fresh, Prime's own reading
 *    through a throwaway Codex app-server signed in with that token.
 *  - For Anthropic, no identity is recorded, but the access token can read
 *    the same usage endpoint Claude's gauge uses. While that token is fresh
 *    the reading *is* Prime's capacity, no matching required. Prime only
 *    refreshes the token while it is running a turn on Anthropic, so the
 *    reading comes and goes with use; an expired token is not sent at all.
 *
 * Read-only, like every other credential read here: Pylon never refreshes
 * or rewrites Prime's sign-in. Every failure yields an empty list, which the
 * client renders as "assumed" rather than "verified".
 *
 * @module provider/primeAgentBackends
 */
import * as NodeOS from "node:os";

import type {
  PrimeAgentSettings,
  ServerProviderBackend,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolveProviderHomePath } from "../pathExpansion.ts";
import { fetchOAuthUsageWithToken } from "./claudeOAuthUsage.ts";
import { codexAppServerArgs } from "./Layers/codexLaunchArgs.ts";
import { buildCodexInitializeParams } from "./Layers/CodexProvider.ts";
import { usageLimitsFromCodexRateLimits } from "./providerUsageLimits.ts";
import {
  acquireSharedUsageLock,
  decideSharedUsageRead,
  readSharedUsageEntry,
  releaseSharedUsageLock,
  resolveSharedUsageCacheDir,
  sharedUsageReadKey,
  writeSharedUsageEntry,
} from "./sharedUsageReadCache.ts";

export const PRIME_AGENT_ANTHROPIC_BACKEND = "anthropic";
export const PRIME_AGENT_CODEX_BACKEND = "openai-codex";

/**
 * A token about to expire is as good as expired: the read would land just
 * as Prime rotates it, and a 401 costs a request for nothing.
 */
const TOKEN_FRESHNESS_MARGIN_MS = 60_000;

/** Bounds the throwaway app-server used to read Prime's ChatGPT capacity. */
const CODEX_CAPACITY_READ_TIMEOUT_MS = 15_000;

const PrimeAuthEntry = Schema.Struct({
  type: Schema.optional(Schema.String),
  access: Schema.optional(Schema.NullOr(Schema.String)),
  /** Unix milliseconds. */
  expires: Schema.optional(Schema.NullOr(Schema.Number)),
  accountId: Schema.optional(Schema.NullOr(Schema.String)),
});

const PrimeAuthFile = Schema.Record(Schema.String, Schema.NullOr(PrimeAuthEntry));
const decodePrimeAuthFile = Schema.decodeUnknownOption(Schema.fromJsonString(PrimeAuthFile));

export interface PrimeAgentBackendSignIn {
  readonly backend: string;
  readonly accountId?: string | undefined;
  /** Present only while the access token is fresh enough to use. */
  readonly accessToken?: string | undefined;
}

function freshAccessToken(
  entry: {
    readonly access?: string | null | undefined;
    readonly expires?: number | null | undefined;
  },
  nowMs: number,
): string | undefined {
  const accessToken = entry.access?.trim();
  const fresh =
    typeof entry.expires === "number" &&
    Number.isFinite(entry.expires) &&
    entry.expires - nowMs > TOKEN_FRESHNESS_MARGIN_MS;
  return accessToken && fresh ? accessToken : undefined;
}

/**
 * The sign-ins recorded in Prime's `auth.json`, keeping only what the
 * capacity readout needs: an identity and, while fresh, a token for each
 * backend that has subscription windows. Tokens never leave this process
 * except to the backend that issued them.
 */
export function primeAgentSignInsFromAuthFile(
  raw: string,
  nowMs: number,
): ReadonlyArray<PrimeAgentBackendSignIn> {
  const decoded = decodePrimeAuthFile(raw);
  if (Option.isNone(decoded)) return [];
  const signIns: PrimeAgentBackendSignIn[] = [];
  for (const [backend, entry] of Object.entries(decoded.value)) {
    if (!entry) continue;
    if (backend === PRIME_AGENT_CODEX_BACKEND) {
      const accountId = entry.accountId?.trim();
      if (!accountId) continue;
      const accessToken = freshAccessToken(entry, nowMs);
      signIns.push({ backend, accountId, ...(accessToken ? { accessToken } : {}) });
      continue;
    }
    if (backend === PRIME_AGENT_ANTHROPIC_BACKEND) {
      const accessToken = freshAccessToken(entry, nowMs);
      signIns.push({ backend, ...(accessToken ? { accessToken } : {}) });
    }
  }
  return signIns;
}

/** Prime's agent home: the configured path, or Prime's own default. */
export function resolvePrimeAgentHomePath(
  settings: Pick<PrimeAgentSettings, "agentHomePath">,
  path: Path.Path,
): string {
  const configured = settings.agentHomePath.trim();
  return configured
    ? resolveProviderHomePath(configured)
    : path.join(NodeOS.homedir(), ".prime", "agent");
}

/**
 * Read Prime's ChatGPT capacity the only way it can be read: through a Codex
 * app-server, signed in with the token Prime holds.
 *
 * The app-server runs against an empty, scoped temp home — none of Prime's
 * files, none of any configured Codex instance's — and is handed the access
 * token and account id alone (`chatgptAuthTokens`), never the refresh token,
 * so it can rotate nothing. It writes only its own logs there, and the
 * directory goes with the scope. One process per read, bounded, and only
 * when no fresh shared reading exists.
 */
export const readPrimeAgentCodexWindows = Effect.fn("readPrimeAgentCodexWindows")(
  function* (signIn: {
    readonly accessToken: string;
    readonly accountId: string;
  }): Effect.fn.Return<
    CodexSchema.V2GetAccountRateLimitsResponse | undefined,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  > {
    return yield* Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pylon-prime-codex-" });
      const environment = { ...process.env, CODEX_HOME: home };
      const spawnCommand = yield* resolveSpawnCommand("codex", codexAppServerArgs(undefined), {
        env: environment,
        extendEnv: true,
      });
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: environment,
          extendEnv: true,
          shell: spawnCommand.shell,
        }),
      );
      const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);
      yield* client.request("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: signIn.accessToken,
        chatgptAccountId: signIn.accountId,
      });
      return yield* client.request("account/rateLimits/read", undefined);
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(CODEX_CAPACITY_READ_TIMEOUT_MS),
      Effect.map(Option.getOrUndefined),
      Effect.catchCause(() =>
        Effect.succeed(undefined as CodexSchema.V2GetAccountRateLimitsResponse | undefined),
      ),
    );
  },
);

/**
 * Prime's ChatGPT capacity through the machine-wide shared reading, under a
 * key that names Prime's account: a re-login to another account never shows
 * the old one's numbers.
 */
const readPrimeAgentCodexCapacity = Effect.fn("readPrimeAgentCodexCapacity")(function* (input: {
  readonly signIn: { readonly accessToken: string; readonly accountId: string };
  readonly homePath: string;
  readonly nowMs: number;
  readonly freshForMs: number | undefined;
  readonly sharedCacheDir: string | undefined;
  readonly readWindows: (signIn: {
    readonly accessToken: string;
    readonly accountId: string;
  }) => Effect.Effect<CodexSchema.V2GetAccountRateLimitsResponse | undefined>;
}): Effect.fn.Return<
  ServerProviderUsageLimits | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const cacheDir = input.sharedCacheDir ?? (yield* resolveSharedUsageCacheDir);
  const cacheKey = sharedUsageReadKey(["prime-codex", input.homePath, input.signIn.accountId]);
  const shared = decideSharedUsageRead(
    yield* readSharedUsageEntry(cacheDir, cacheKey),
    input.nowMs,
    input.freshForMs,
  );
  if (shared.kind === "fresh") return shared.usageLimits;
  if (shared.kind === "throttled") return undefined;
  if (!(yield* acquireSharedUsageLock(cacheDir, cacheKey, input.nowMs))) {
    return (yield* readSharedUsageEntry(cacheDir, cacheKey))?.usageLimits;
  }
  return yield* Effect.gen(function* () {
    const response = yield* input.readWindows(input.signIn);
    if (!response) return undefined;
    const readAt = DateTime.formatIso(DateTime.makeUnsafe(input.nowMs));
    const usageLimits = usageLimitsFromCodexRateLimits(response, readAt, "primeAgentCodex");
    if (usageLimits) {
      yield* writeSharedUsageEntry(cacheDir, cacheKey, { version: 1, readAt, usageLimits });
    }
    return usageLimits;
  }).pipe(Effect.ensuring(releaseSharedUsageLock(cacheDir, cacheKey)));
});

export interface ReadPrimeAgentBackendsOptions {
  readonly sharedCacheDir?: string | undefined;
  /**
   * How recent a shared reading must be to be served instead of read again.
   * The periodic probe leaves this at the shared window; the turn-end read
   * passes a minute, because the number just changed.
   */
  readonly freshForMs?: number | undefined;
  /** Test seam for the app-server read; defaults to the real one. */
  readonly readCodexWindows?:
    | ((signIn: {
        readonly accessToken: string;
        readonly accountId: string;
      }) => Effect.Effect<CodexSchema.V2GetAccountRateLimitsResponse | undefined>)
    | undefined;
}

/**
 * Read Prime's backend sign-ins and, where its credential is fresh, its own
 * capacity: Anthropic through the usage endpoint, ChatGPT through a
 * throwaway app-server. Both go through the machine-wide shared cache under
 * Prime's own keys, so several servers cost each backend one read per window.
 */
export const readPrimeAgentBackends = Effect.fn("readPrimeAgentBackends")(function* (
  settings: Pick<PrimeAgentSettings, "agentHomePath">,
  options?: ReadPrimeAgentBackendsOptions,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderBackend>,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = resolvePrimeAgentHomePath(settings, path);
  const raw = yield* fileSystem.readFileString(path.join(homePath, "auth.json")).pipe(
    Effect.map(Option.some),
    Effect.catchCause(() => Effect.succeed(Option.none<string>())),
  );
  if (Option.isNone(raw)) return [];

  const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const readWindows =
    options?.readCodexWindows ??
    ((signIn: { readonly accessToken: string; readonly accountId: string }) =>
      readPrimeAgentCodexWindows(signIn).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ));
  const backends: ServerProviderBackend[] = [];
  for (const signIn of primeAgentSignInsFromAuthFile(raw.value, nowMs)) {
    if (signIn.backend === PRIME_AGENT_ANTHROPIC_BACKEND && signIn.accessToken) {
      const read = yield* fetchOAuthUsageWithToken({
        token: signIn.accessToken,
        cacheKey: sharedUsageReadKey(["prime-anthropic", homePath]),
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        source: "primeAgentOAuth",
        sharedCacheDir: options?.sharedCacheDir,
        freshForMs: options?.freshForMs,
      });
      backends.push({
        backend: signIn.backend,
        ...(read.usageLimits ? { usageLimits: read.usageLimits } : {}),
      });
      continue;
    }
    if (signIn.backend === PRIME_AGENT_CODEX_BACKEND && signIn.accountId && signIn.accessToken) {
      const usageLimits = yield* readPrimeAgentCodexCapacity({
        signIn: { accessToken: signIn.accessToken, accountId: signIn.accountId },
        homePath,
        nowMs,
        freshForMs: options?.freshForMs,
        sharedCacheDir: options?.sharedCacheDir,
        readWindows,
      });
      backends.push({
        backend: signIn.backend,
        accountId: signIn.accountId,
        ...(usageLimits ? { usageLimits } : {}),
      });
      continue;
    }
    backends.push({
      backend: signIn.backend,
      ...(signIn.accountId ? { accountId: signIn.accountId } : {}),
    });
  }
  return backends;
});
