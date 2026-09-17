import * as FileSystem from "effect/FileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  parseAntigravityBucketToWindow,
  parseAntigravityWindowDurationMins,
  resolveAntigravityCliExecutable,
  usageLimitsFromAntigravityOutput,
} from "./antigravityUsageLimits.ts";

describe("antigravityUsageLimits", () => {
  describe("parseAntigravityWindowDurationMins", () => {
    it("parses named windows accurately without guessing", () => {
      expect(parseAntigravityWindowDurationMins("weekly")).toBe(10_080);
      expect(parseAntigravityWindowDurationMins("Weekly")).toBe(10_080);
      expect(parseAntigravityWindowDurationMins("daily")).toBe(1_440);
      expect(parseAntigravityWindowDurationMins("monthly")).toBe(43_200);
    });

    it("parses hour and minute duration formats", () => {
      expect(parseAntigravityWindowDurationMins("5h")).toBe(300);
      expect(parseAntigravityWindowDurationMins("5 hours")).toBe(300);
      expect(parseAntigravityWindowDurationMins("12h")).toBe(720);
      expect(parseAntigravityWindowDurationMins("30m")).toBe(30);
      expect(parseAntigravityWindowDurationMins("2d")).toBe(2_880);
    });

    it("returns undefined for unknown or absent durations rather than guessing 5h", () => {
      expect(parseAntigravityWindowDurationMins(undefined)).toBeUndefined();
      expect(parseAntigravityWindowDurationMins("")).toBeUndefined();
      expect(parseAntigravityWindowDurationMins("unknown_window")).toBeUndefined();
    });
  });

  describe("parseAntigravityBucketToWindow", () => {
    it("parses a Gemini 5h bucket correctly", () => {
      const window = parseAntigravityBucketToWindow("Gemini Models", {
        id: "gemini-5h",
        name: "Five Hour Limit Remaining",
        window: "5h",
        remaining_fraction: 0.476,
        reset_time: "2026-09-17T22:49:06Z",
      });

      expect(window).toEqual({
        id: "gemini-5h",
        label: "5-Hour (Gemini)",
        usedPercent: 52, // 1 - 0.476 = 0.524 -> 52%
        kind: "session",
        windowDurationMins: 300,
        resetsAt: "2026-09-17T22:49:06.000Z",
      });
    });

    it("parses a 3p Weekly bucket correctly", () => {
      const window = parseAntigravityBucketToWindow("Claude and GPT models", {
        id: "3p-weekly",
        name: "Weekly Limit Remaining",
        window: "weekly",
        remaining_fraction: 0.9,
        reset_time: "2026-09-24T18:43:46Z",
      });

      expect(window).toEqual({
        id: "3p-weekly",
        label: "Weekly (Claude/GPT)",
        usedPercent: 10,
        kind: "weekly",
        windowDurationMins: 10_080,
        resetsAt: "2026-09-24T18:43:46.000Z",
      });
    });

    it("bounds usedPercent strictly between 0 and 100", () => {
      const negative = parseAntigravityBucketToWindow("Gemini Models", {
        id: "gemini-5h",
        remaining_fraction: 1.5,
      });
      expect(negative?.usedPercent).toBe(0);

      const overflow = parseAntigravityBucketToWindow("Gemini Models", {
        id: "gemini-5h",
        remaining_fraction: -0.5,
      });
      expect(overflow?.usedPercent).toBe(100);
    });

    it("handles invalid reset_time without throwing", () => {
      const window = parseAntigravityBucketToWindow("Gemini Models", {
        id: "gemini-5h",
        remaining_fraction: 0.5,
        reset_time: "not-a-date",
      });
      expect(window?.resetsAt).toBeUndefined();
      expect(window?.usedPercent).toBe(50);
    });

    it("returns undefined when remaining_fraction is missing or non-numeric", () => {
      expect(
        parseAntigravityBucketToWindow("Gemini Models", {
          id: "gemini-5h",
          window: "5h",
        } as unknown as { remaining_fraction: number }),
      ).toBeUndefined();
    });
  });

  describe("usageLimitsFromAntigravityOutput", () => {
    it("parses live CLI agy -p '/usage' --output-format json output structure", () => {
      const liveJson = {
        status: "SUCCESS",
        command: {
          name: "usage",
          data: {
            description: "Usage and quota limits",
            groups: [
              {
                name: "Gemini Models",
                description: "Models within this group: Gemini Flash, Gemini Pro",
                buckets: [
                  {
                    id: "gemini-weekly",
                    name: "Weekly Limit Remaining",
                    window: "weekly",
                    remaining_fraction: 0.942,
                    reset_time: "2026-09-24T17:49:06Z",
                  },
                  {
                    id: "gemini-5h",
                    name: "Five Hour Limit Remaining",
                    window: "5h",
                    remaining_fraction: 0.476,
                    reset_time: "2026-09-17T22:49:06Z",
                  },
                ],
              },
              {
                name: "Claude and GPT models",
                description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
                buckets: [
                  {
                    id: "3p-weekly",
                    name: "Weekly Limit Remaining",
                    window: "weekly",
                    remaining_fraction: 1.0,
                    reset_time: "2026-09-24T18:43:46Z",
                  },
                  {
                    id: "3p-5h",
                    name: "Five Hour Limit Remaining",
                    window: "5h",
                    remaining_fraction: 1.0,
                    reset_time: "2026-09-17T23:43:46Z",
                  },
                ],
              },
            ],
          },
        },
      };

      const limits = usageLimitsFromAntigravityOutput(liveJson, "2026-09-17T18:00:00.000Z");
      expect(limits).toBeDefined();
      expect(limits?.source).toBe("antigravityCli");
      expect(limits?.checkedAt).toBe("2026-09-17T18:00:00.000Z");
      expect(limits?.windows).toHaveLength(4);
      expect(limits?.windows[0]).toMatchObject({
        id: "gemini-weekly",
        label: "Weekly (Gemini)",
        usedPercent: 6,
      });
      expect(limits?.windows[1]).toMatchObject({
        id: "gemini-5h",
        label: "5-Hour (Gemini)",
        usedPercent: 52,
      });
      expect(limits?.windows[2]).toMatchObject({
        id: "3p-weekly",
        label: "Weekly (Claude/GPT)",
        usedPercent: 0,
      });
      expect(limits?.windows[3]).toMatchObject({
        id: "3p-5h",
        label: "5-Hour (Claude/GPT)",
        usedPercent: 0,
      });
    });

    it("returns undefined for empty, malformed, or error payloads", () => {
      expect(usageLimitsFromAntigravityOutput(null, "2026-09-17T18:00:00.000Z")).toBeUndefined();
      expect(usageLimitsFromAntigravityOutput({}, "2026-09-17T18:00:00.000Z")).toBeUndefined();
      expect(
        usageLimitsFromAntigravityOutput({ status: "ERROR" }, "2026-09-17T18:00:00.000Z"),
      ).toBeUndefined();
      expect(
        usageLimitsFromAntigravityOutput(
          { status: "SUCCESS", command: { data: { groups: null } } },
          "2026-09-17T18:00:00.000Z",
        ),
      ).toBeUndefined();
    });
  });

  describe("resolveAntigravityCliExecutable", () => {
    it("returns undefined when binary is not in PATH or search locations", async () => {
      const mockFs = FileSystem.FileSystem.of({
        ...({} as unknown as FileSystem.FileSystem),
        exists: () => Effect.succeed(false),
      });

      const result = await Effect.runPromise(
        resolveAntigravityCliExecutable({
          baseEnv: { PATH: "/nonexistent/bin" },
          userHome: "/home/user",
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, mockFs),
          Effect.provide(NodePath.layerPosix),
        ),
      );

      expect(result).toBeUndefined();
    });

    it("finds binary when present in PATH", async () => {
      const isWindows = process.platform === "win32";
      const expectedBin = isWindows ? "C:\\bin\\agy.exe" : "/custom/bin/agy";
      const mockFs = FileSystem.FileSystem.of({
        ...({} as unknown as FileSystem.FileSystem),
        exists: (p: string) => Effect.succeed(p === expectedBin),
      });

      const result = await Effect.runPromise(
        resolveAntigravityCliExecutable({
          baseEnv: { PATH: isWindows ? "C:\\bin" : "/custom/bin" },
          userHome: isWindows ? "C:\\Users\\test" : "/home/user",
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, mockFs),
          Effect.provide(isWindows ? NodePath.layerWin32 : NodePath.layerPosix),
        ),
      );

      expect(result).toBe(expectedBin);
    });
  });
});
