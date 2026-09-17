/**
 * Rate limit and quota parser for Antigravity.
 *
 * Antigravity CLI provides structured quota telemetry via:
 *   `agy -p '/usage' --output-format json` (also `/quota`, `/credits`)
 *
 * This command executes locally in ~300ms, incurs zero LLM turns, spends zero
 * quota, and writes no conversation records. It returns structured bucket
 * groups for Gemini models and third-party models (Claude/GPT) with explicit
 * `remaining_fraction`, `reset_time`, and `window` identifiers.
 *
 * @module provider/Layers/antigravityUsageLimits
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeUnavailableUsageLimits } from "../usageLimitsSnapshot.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";

const DAY_MINS = 24 * 60;
const WEEK_MINS = 7 * DAY_MINS;
const MONTH_MINS = 30 * DAY_MINS;

export const AntigravityBucketSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  remaining_fraction: Schema.Number,
  reset_time: Schema.optional(Schema.String),
});
export type AntigravityBucket = typeof AntigravityBucketSchema.Type;

export const AntigravityGroupSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(AntigravityBucketSchema)),
});
export type AntigravityGroup = typeof AntigravityGroupSchema.Type;

export const AntigravityUsageDataSchema = Schema.Struct({
  description: Schema.optional(Schema.String),
  groups: Schema.optional(Schema.Array(AntigravityGroupSchema)),
});

export const AntigravityUsageCommandSchema = Schema.Struct({
  status: Schema.String,
  command: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      data: Schema.optional(AntigravityUsageDataSchema),
    }),
  ),
});
export type AntigravityUsageCommand = typeof AntigravityUsageCommandSchema.Type;

const decodeUsageCommand = Schema.decodeUnknownOption(AntigravityUsageCommandSchema);

/**
 * Parses window duration dynamically from the CLI window string.
 * Never guesses 5h duration if the window specifies another timeframe.
 */
export function parseAntigravityWindowDurationMins(windowStr?: string): number | undefined {
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
    windowLabel = bucket.name?.replace(" Remaining", "").replace(" Limit", "") ?? "Limit";
  }

  return tag ? `${windowLabel} (${tag})` : windowLabel;
}

export function parseAntigravityBucketToWindow(
  groupName: string | undefined,
  bucket: AntigravityBucket,
): ServerProviderUsageWindow | undefined {
  if (
    typeof bucket.remaining_fraction !== "number" ||
    !Number.isFinite(bucket.remaining_fraction)
  ) {
    return undefined;
  }

  const fraction = Math.max(0, Math.min(1, bucket.remaining_fraction));
  const usedPercent = Math.max(0, Math.min(100, Math.round((1 - fraction) * 100)));
  const windowDurationMins = parseAntigravityWindowDurationMins(bucket.window);

  let kind: ServerProviderUsageWindow["kind"] = undefined;
  if (windowDurationMins !== undefined) {
    if (windowDurationMins >= WEEK_MINS) {
      kind = "weekly";
    } else if (windowDurationMins <= DAY_MINS) {
      kind = "session";
    }
  }

  let resetsAt: string | undefined = undefined;
  if (bucket.reset_time && typeof bucket.reset_time === "string") {
    const parsedDate = DateTime.make(bucket.reset_time);
    if (Option.isSome(parsedDate)) {
      resetsAt = DateTime.formatIso(parsedDate.value);
    }
  }

  const label = labelForBucket(groupName, bucket);

  return {
    ...(bucket.id ? { id: bucket.id } : {}),
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
  source = "antigravityCli",
): ServerProviderUsageLimits | undefined {
  const decodedOpt = decodeUsageCommand(raw);
  if (Option.isNone(decodedOpt)) return undefined;
  const commandOutput = decodedOpt.value;
  if (commandOutput.status !== "SUCCESS") return undefined;

  const data = commandOutput.command?.data;
  if (!data || !Array.isArray(data.groups)) return undefined;

  const windows: ServerProviderUsageWindow[] = [];
  for (const group of data.groups) {
    if (!group || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      if (!bucket) continue;
      const window = parseAntigravityBucketToWindow(group.name, bucket);
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

/**
 * Resolves the official `agy` CLI independently from PATH or standard install locations.
 *
 * NOTE: This resolves the user-facing `agy` CLI binary, NOT the managed
 * `agy_acp_server.par` self-extracting archive which runs the ACP protocol.
 */
export function resolveAntigravityCliExecutable(input: {
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly userHome: string;
}): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const isWindows = process.platform === "win32";
    const binaryName = isWindows ? "agy.exe" : "agy";

    // Check candidate directories from PATH
    const pathEnv = input.baseEnv["PATH"] ?? process.env["PATH"] ?? "";
    const pathDirs = pathEnv.split(isWindows ? ";" : ":").filter((p) => p.length > 0);

    const standardDirs = isWindows
      ? [
          path.join(input.userHome, "AppData", "Local", "Programs", "agy"),
          path.join(input.userHome, "bin"),
        ]
      : [
          path.join(input.userHome, ".local", "bin"),
          "/usr/local/bin",
          "/opt/homebrew/bin",
          "/usr/bin",
        ];

    const searchDirs = [...pathDirs, ...standardDirs];
    const seen = new Set<string>();

    for (const dir of searchDirs) {
      const candidate = path.join(dir, binaryName);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        return candidate;
      }
    }

    return undefined;
  });
}

export function runAntigravityUsageProbe(input: {
  readonly executablePath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}): Effect.Effect<ServerProviderUsageLimits, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const now = yield* DateTime.now;
    const checkedAt = DateTime.formatIso(now);

    const command = ChildProcess.make(
      input.executablePath,
      ["-p", "/usage", "--output-format", "json"],
      {
        env: input.env,
        shell: false,
        stdin: "ignore",
        ...(input.cwd ? { cwd: input.cwd } : {}),
      },
    );

    const result = yield* spawnAndCollect(input.executablePath, command).pipe(
      Effect.orElseSucceed(() => undefined),
    );

    if (!result) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity usage probe process could not be started.",
      });
    }

    if (result.code !== 0) {
      const combinedOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (
        combinedOutput.includes("authentication required") ||
        combinedOutput.includes("authentication failed") ||
        combinedOutput.includes("log in")
      ) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Antigravity CLI is not authenticated.",
        });
      }
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: `Antigravity usage probe failed with exit code ${result.code}.`,
      });
    }

    try {
      const parsed = JSON.parse(result.stdout);
      const limits = usageLimitsFromAntigravityOutput(parsed, checkedAt);
      if (!limits) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Antigravity usage limits could not be parsed.",
        });
      }
      return limits;
    } catch {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity usage limits output is not valid JSON.",
      });
    }
  });
}
