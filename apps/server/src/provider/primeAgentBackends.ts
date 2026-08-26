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
 *    instance also reports (`auth.accountId`). Equal ids mean one
 *    subscription.
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

import type { PrimeAgentSettings, ServerProviderBackend } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { resolveProviderHomePath } from "../pathExpansion.ts";
import { fetchOAuthUsageWithToken } from "./claudeOAuthUsage.ts";
import { sharedUsageReadKey } from "./sharedUsageReadCache.ts";

export const PRIME_AGENT_ANTHROPIC_BACKEND = "anthropic";
export const PRIME_AGENT_CODEX_BACKEND = "openai-codex";

/**
 * A token about to expire is as good as expired: the read would land just
 * as Prime rotates it, and a 401 costs a request for nothing.
 */
const TOKEN_FRESHNESS_MARGIN_MS = 60_000;

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

/**
 * The sign-ins recorded in Prime's `auth.json`, keeping only what the
 * capacity readout needs: an identity for Codex, a usable token for
 * Anthropic. Tokens never leave this process.
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
      if (accountId) signIns.push({ backend, accountId });
      continue;
    }
    if (backend === PRIME_AGENT_ANTHROPIC_BACKEND) {
      const accessToken = entry.access?.trim();
      const fresh =
        typeof entry.expires === "number" &&
        Number.isFinite(entry.expires) &&
        entry.expires - nowMs > TOKEN_FRESHNESS_MARGIN_MS;
      signIns.push({ backend, ...(accessToken && fresh ? { accessToken } : {}) });
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
 * Read Prime's backend sign-ins and, for Anthropic, its current capacity.
 * The Anthropic read goes through the same machine-wide shared cache as
 * Claude's, under Prime's own key.
 */
export const readPrimeAgentBackends = Effect.fn("readPrimeAgentBackends")(function* (
  settings: Pick<PrimeAgentSettings, "agentHomePath">,
  options?: { readonly sharedCacheDir?: string | undefined },
): Effect.fn.Return<
  ReadonlyArray<ServerProviderBackend>,
  never,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
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
  const backends: ServerProviderBackend[] = [];
  for (const signIn of primeAgentSignInsFromAuthFile(raw.value, nowMs)) {
    if (signIn.backend === PRIME_AGENT_ANTHROPIC_BACKEND && signIn.accessToken) {
      const read = yield* fetchOAuthUsageWithToken({
        token: signIn.accessToken,
        cacheKey: sharedUsageReadKey(["prime-anthropic", homePath]),
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        source: "primeAgentOAuth",
        sharedCacheDir: options?.sharedCacheDir,
      });
      backends.push({
        backend: signIn.backend,
        ...(read.usageLimits ? { usageLimits: read.usageLimits } : {}),
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
