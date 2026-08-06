import { describe, expect, it } from "vite-plus/test";

import { buildProviderUsageMatrix, isUsageReadingStale } from "./ProviderUsageMatrix.logic";
import type { ProviderUsageAccount } from "./ProviderUsageAccounts";

const CHECKED_AT = "2026-08-06T12:00:00.000Z";
const NOW = Date.parse(CHECKED_AT);

const account = (input: {
  id: string;
  name: string;
  windows: ReadonlyArray<{ label: string; usedPercent: number; resetsAt?: string }>;
  isActive?: boolean;
}): ProviderUsageAccount => ({
  instanceId: input.id,
  displayName: input.name,
  isActive: input.isActive ?? false,
  usageLimits: {
    source: "claudeOAuth",
    checkedAt: CHECKED_AT,
    windows: input.windows.map((window) => ({
      label: window.label,
      usedPercent: window.usedPercent,
      ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
    })),
  },
});

describe("buildProviderUsageMatrix", () => {
  const PERSONAL = account({
    id: "claudeAgent",
    name: "Personal",
    windows: [
      { label: "Session", usedPercent: 17 },
      { label: "Weekly (all models)", usedPercent: 50 },
    ],
  });
  const WORK = account({
    id: "claudeAgent_work",
    name: "Work",
    isActive: true,
    windows: [
      { label: "Session", usedPercent: 23 },
      { label: "Weekly (all models)", usedPercent: 27 },
    ],
  });

  // The point of the layout: one row per window, one cell per account.
  it("puts each window on one row shared by every account", () => {
    const matrix = buildProviderUsageMatrix([PERSONAL, WORK]);

    expect(matrix.rows.map((row) => row.label)).toEqual(["Session", "Weekly (all models)"]);
    expect(matrix.rows[0]?.cells).toHaveLength(2);
  });

  // "% remaining" is the number people act on; the bar drains to match.
  it("reports what is left rather than what is spent", () => {
    const matrix = buildProviderUsageMatrix([PERSONAL, WORK]);

    expect(matrix.rows[0]?.cells[0]?.remainingPercent).toBe(83);
    expect(matrix.rows[0]?.cells[1]?.remainingPercent).toBe(77);
  });

  // Team and API accounts genuinely report different windows, so a missing one
  // has to read as absent rather than as zero.
  it("leaves an empty cell for a window an account does not report", () => {
    const consoleAccount = account({
      id: "claudeAgent_api",
      name: "API",
      windows: [{ label: "Session", usedPercent: 10 }],
    });
    const matrix = buildProviderUsageMatrix([PERSONAL, consoleAccount]);

    const weeklyRow = matrix.rows.find((row) => row.label === "Weekly (all models)");
    expect(weeklyRow?.cells[1]?.window).toBeUndefined();
    expect(weeklyRow?.cells[1]?.remainingPercent).toBeUndefined();
  });

  it("keeps a window only the second account reports", () => {
    const withFable = account({
      id: "claudeAgent_work",
      name: "Work",
      windows: [{ label: "Weekly (Fable)", usedPercent: 1 }],
    });
    const matrix = buildProviderUsageMatrix([PERSONAL, withFable]);

    expect(matrix.rows.map((row) => row.label)).toContain("Weekly (Fable)");
  });

  // The soonest reset is the one that changes the answer first.
  it("uses the earliest reset across a row", () => {
    const matrix = buildProviderUsageMatrix([
      account({
        id: "a",
        name: "A",
        windows: [{ label: "Session", usedPercent: 5, resetsAt: "2026-08-06T18:00:00.000Z" }],
      }),
      account({
        id: "b",
        name: "B",
        windows: [{ label: "Session", usedPercent: 5, resetsAt: "2026-08-06T15:00:00.000Z" }],
      }),
    ]);

    expect(matrix.rows[0]?.resetsAt).toBe("2026-08-06T15:00:00.000Z");
  });

  it("returns no rows when nothing reports usage", () => {
    expect(buildProviderUsageMatrix([]).rows).toEqual([]);
  });
});

describe("isUsageReadingStale", () => {
  it("treats a just-taken reading as current", () => {
    expect(isUsageReadingStale({ checkedAt: CHECKED_AT, nowMs: NOW })).toBe(false);
  });

  // The server keeps serving the last good reading instead of blanking the
  // gauge; that is only honest if the client admits when it is not current.
  it("marks a reading the server has stopped refreshing", () => {
    expect(isUsageReadingStale({ checkedAt: CHECKED_AT, nowMs: NOW + 10 * 60_000 })).toBe(true);
  });

  it("does not claim staleness it cannot establish", () => {
    expect(isUsageReadingStale({ checkedAt: "nonsense", nowMs: NOW })).toBe(false);
  });
});
