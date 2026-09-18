/** Native ACP account quotas, verified against agy_acp_server_1.1.1's CCPA client.
 * These private endpoints may change. Fail closed; never use a different CLI account.
 */
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeUnavailableUsageLimits } from "../usageLimitsSnapshot.ts";

const DAY_MINS = 24 * 60;
const WEEK_MINS = 7 * DAY_MINS;
const MONTH_MINS = 30 * DAY_MINS;

export const AntigravityBucketSchema = Schema.Struct({
  bucketId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  remainingFraction: Schema.Finite,
  resetTime: Schema.optional(Schema.String),
});
export type AntigravityBucket = typeof AntigravityBucketSchema.Type;

export const AntigravityGroupSchema = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(AntigravityBucketSchema)),
});
export type AntigravityGroup = typeof AntigravityGroupSchema.Type;

export const AntigravityUsageDataSchema = Schema.Struct({
  description: Schema.optional(Schema.String),
  groups: Schema.optional(Schema.Array(AntigravityGroupSchema)),
});

const decodeUsage = Schema.decodeUnknownOption(AntigravityUsageDataSchema);

/**
 * Parses window duration dynamically from the CLI window string.
 * Never guesses 5h duration if the window specifies another timeframe.
 */
function parseAntigravityWindowDurationMins(windowStr?: string): number | undefined {
  if (!windowStr) return undefined;
  const lower = windowStr.toLowerCase().trim();
  if (lower === "weekly") return WEEK_MINS;
  if (lower === "daily") return DAY_MINS;
  if (lower === "monthly") return MONTH_MINS;

  const matchHours = lower.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?)?$/);
  if (matchHours && matchHours[1]) return Math.round(parseFloat(matchHours[1]) * 60);

  const matchDays = lower.match(/^(\d+(?:\.\d+)?)\s*d(?:ays?)?$/);
  if (matchDays && matchDays[1]) return Math.round(parseFloat(matchDays[1]) * DAY_MINS);

  const matchMins = lower.match(/^(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?$/);
  if (matchMins && matchMins[1]) return Math.round(parseFloat(matchMins[1]));

  return undefined;
}

function labelForBucket(groupName: string | undefined, bucket: AntigravityBucket): string {
  const isGemini = groupName?.toLowerCase().includes("gemini");
  const is3p =
    groupName?.toLowerCase().includes("claude") ||
    groupName?.toLowerCase().includes("gpt") ||
    groupName?.toLowerCase().includes("3p");
  const tag = isGemini ? "Gemini" : is3p ? "Claude/GPT" : groupName?.trim();

  const windowDuration = parseAntigravityWindowDurationMins(bucket.window);
  let windowLabel: string;
  if (windowDuration === 300) {
    windowLabel = "5-Hour";
  } else if (windowDuration === WEEK_MINS) {
    windowLabel = "Weekly";
  } else if (windowDuration === DAY_MINS) {
    windowLabel = "Daily";
  } else if (windowDuration === MONTH_MINS) {
    windowLabel = "Monthly";
  } else if (windowDuration !== undefined) {
    windowLabel =
      windowDuration >= 60 ? `${Math.round(windowDuration / 60)}h` : `${windowDuration}m`;
  } else {
    windowLabel = bucket.displayName?.replace(" Remaining", "").replace(" Limit", "") ?? "Limit";
  }

  return tag ? `${windowLabel} (${tag})` : windowLabel;
}

function parseAntigravityBucketToWindow(
  groupName: string | undefined,
  bucket: AntigravityBucket,
): ServerProviderUsageWindow | undefined {
  if (typeof bucket.remainingFraction !== "number" || !Number.isFinite(bucket.remainingFraction)) {
    return undefined;
  }

  const fraction = Math.max(0, Math.min(1, bucket.remainingFraction));
  const usedPercent = Math.max(0, Math.min(100, Math.round((1 - fraction) * 100)));
  const windowDurationMins = parseAntigravityWindowDurationMins(bucket.window);

  let kind: ServerProviderUsageWindow["kind"] = undefined;
  if (windowDurationMins !== undefined) {
    if (windowDurationMins >= MONTH_MINS) {
      kind = "monthly";
    } else if (windowDurationMins >= WEEK_MINS) {
      kind = "weekly";
    } else if (windowDurationMins <= DAY_MINS) {
      kind = "session";
    }
  }

  let resetsAt: string | undefined = undefined;
  if (bucket.resetTime && typeof bucket.resetTime === "string") {
    const parsedDate = DateTime.make(bucket.resetTime);
    if (Option.isSome(parsedDate)) {
      resetsAt = DateTime.formatIso(parsedDate.value);
    }
  }

  const label = labelForBucket(groupName, bucket);

  return {
    ...(bucket.bucketId ? { id: bucket.bucketId } : {}),
    label,
    usedPercent,
    ...(kind ? { kind } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

export function usageLimitsFromAntigravityOutput(
  raw: unknown,
  checkedAt: string,
  source = "antigravityOAuth",
): ServerProviderUsageLimits | undefined {
  const decodedOpt = decodeUsage(raw);
  if (Option.isNone(decodedOpt)) return undefined;
  const data = decodedOpt.value;
  if (!data.groups) return undefined;

  const windows: ServerProviderUsageWindow[] = [];
  for (const group of data.groups) {
    if (!group || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      if (!bucket) continue;
      const window = parseAntigravityBucketToWindow(group.displayName, bucket);
      if (window) windows.push(window);
    }
  }

  if (windows.length === 0) return undefined;

  return {
    source,
    checkedAt,
    windows,
  };
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CCPA = "https://cloudcode-pa.googleapis.com";
const DAILY_CCPA = "https://daily-cloudcode-pa.googleapis.com";
const Credentials = Schema.fromJsonString(
  Schema.Struct({
    token_uri: Schema.Literal(TOKEN_URL),
    client_id: Schema.NonEmptyString,
    client_secret: Schema.NonEmptyString,
    refresh_token: Schema.NonEmptyString,
    project_id: Schema.optional(Schema.String),
  }),
);
const AccessToken = Schema.Struct({ access_token: Schema.NonEmptyString });
const Account = Schema.Struct({
  cloudaicompanionProject: Schema.optional(Schema.String),
  paidTier: Schema.optional(Schema.Struct({ usesGcpTos: Schema.optional(Schema.Boolean) })),
});
const decodeCredentials = Schema.decodeEffect(Credentials);
const decodeAccessToken = Schema.decodeUnknownEffect(AccessToken);
const decodeAccount = Schema.decodeUnknownEffect(Account);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
class AntigravityQuotaError extends Schema.TaggedError<AntigravityQuotaError>()(
  "AntigravityQuotaError",
  { message: Schema.String },
) {}

export const readAntigravityUsageLimits = Effect.fn("readAntigravityUsageLimits")(
  function* (input: {
    readonly profileDirectory: string;
    readonly authMethod: string;
    readonly runtimeVersion: string;
  }) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const platform = yield* HostProcessPlatform;
    const architecture = yield* HostProcessArchitecture;
    const unavailable = (reason: "unsupported" | "probeFailed", message: string) =>
      makeUnavailableUsageLimits({ checkedAt, source: "antigravityOAuth", reason, message });
    if (input.authMethod !== "oauth-personal") {
      return unavailable(
        "unsupported",
        "Subscription limits are available for Google-account sign-in only.",
      );
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;
    const tokenPath = path.join(input.profileDirectory, "antigravity-acp", "acp_token.json");
    if (!(yield* fs.exists(tokenPath).pipe(Effect.orElseSucceed(() => false)))) {
      return unavailable("unsupported", "Sign in with Google to see subscription limits.");
    }
    const read = Effect.gen(function* () {
      const stat = yield* fs.stat(tokenPath);
      if (Number(stat.size) > 64 * 1024)
        return yield* new AntigravityQuotaError({ message: "Invalid credential file." });
      const original = yield* fs.readFileString(tokenPath);
      const credentials = yield* decodeCredentials(original);
      // Google's native client uses this header to identify the Antigravity surface.
      const version =
        input.runtimeVersion.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64) || "unknown";
      const userAgent = `antigravity/acp/${version} (aidev_client; os_type=${platform === "win32" ? "windows" : platform}; arch=${architecture === "x64" ? "x86_64" : architecture}; host_path=pylon/0.0.0; proxy_client=antigravity/sdk)`;
      // Keep parse failures inside the outer recovery: a nested failed span could retain response text.
      const requestJson = Effect.fnUntraced(function* (
        request: HttpClientRequest.HttpClientRequest,
      ) {
        const response = yield* http.execute(request);
        if (response.status < 200 || response.status >= 300) {
          return yield* new AntigravityQuotaError({ message: "Antigravity quota request failed." });
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        yield* Stream.runForEach(response.stream, (chunk) =>
          Effect.gen(function* () {
            size += chunk.byteLength;
            if (size > 256 * 1024)
              return yield* new AntigravityQuotaError({ message: "Quota response too large." });
            chunks.push(chunk);
          }),
        );
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return yield* decodeJson(new TextDecoder().decode(body));
      });
      const tokenJson = yield* requestJson(
        HttpClientRequest.post(TOKEN_URL).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: credentials.client_id,
            client_secret: credentials.client_secret,
            refresh_token: credentials.refresh_token,
            grant_type: "refresh_token",
          }),
        ),
      );
      const token = yield* decodeAccessToken(tokenJson);
      const accountRequest = (url: string, body: Record<string, unknown>) =>
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bearerToken(token.access_token),
          HttpClientRequest.setHeader("user-agent", userAgent),
          HttpClientRequest.bodyJsonUnsafe(body),
        );
      const accountJson = yield* requestJson(
        accountRequest(`${CCPA}/v1internal:loadCodeAssist`, {
          metadata: { ideType: "ANTIGRAVITY" },
        }),
      );
      const account = yield* decodeAccount(accountJson);
      const project = account.cloudaicompanionProject || credentials.project_id;
      if (!project)
        return yield* new AntigravityQuotaError({ message: "No existing account project." });
      const endpoint = account.paidTier?.usesGcpTos ? CCPA : DAILY_CCPA;
      const summary = yield* requestJson(
        accountRequest(`${endpoint}/v1internal:retrieveUserQuotaSummary`, { project }),
      );
      const limits = usageLimitsFromAntigravityOutput(summary, checkedAt);
      if (!limits)
        return yield* new AntigravityQuotaError({ message: "Unrecognized quota response." });
      // Sign-out/account replacement may race this read. Never publish the previous account's limits.
      if ((yield* fs.readFileString(tokenPath)) !== original) {
        return unavailable(
          "unsupported",
          "Account changed; refresh to load its subscription limits.",
        );
      }
      return limits;
    });
    return yield* read.pipe(
      Effect.timeoutOption("15 seconds"),
      Effect.map(Option.getOrUndefined),
      // HTTP/schema errors may contain credentials or response bodies: never log or retain them.
      Effect.orElseSucceed(() => undefined),
      Effect.map(
        (limits) =>
          limits ??
          unavailable("probeFailed", "Antigravity subscription limits could not be refreshed."),
      ),
    );
  },
);
