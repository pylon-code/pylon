import { describe, expect, it } from "vite-plus/test";

import { formatTimeSinceChecked } from "./usageTime";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("formatTimeSinceChecked", () => {
  // Under a minute the age cannot change any decision, and "0m ago" reads as a
  // bug. Callers render nothing instead.
  it("stays quiet for a reading younger than a minute", () => {
    expect(formatTimeSinceChecked(ago(30_000), NOW)).toBeUndefined();
  });

  it("reports whole minutes below an hour", () => {
    expect(formatTimeSinceChecked(ago(6 * 60_000), NOW)).toBe("6m");
    expect(formatTimeSinceChecked(ago(59 * 60_000), NOW)).toBe("59m");
  });

  it("adds minutes to hours only when there are some", () => {
    expect(formatTimeSinceChecked(ago(2 * 3_600_000), NOW)).toBe("2h");
    expect(formatTimeSinceChecked(ago(2 * 3_600_000 + 5 * 60_000), NOW)).toBe("2h 5m");
  });

  it("collapses to whole days once a reading is that old", () => {
    expect(formatTimeSinceChecked(ago(3 * 86_400_000), NOW)).toBe("3d");
  });

  // A clock skewed ahead of the server would otherwise render a negative age.
  it("stays quiet for a future or unreadable timestamp", () => {
    expect(formatTimeSinceChecked(new Date(NOW + 60_000).toISOString(), NOW)).toBeUndefined();
    expect(formatTimeSinceChecked("nonsense", NOW)).toBeUndefined();
  });
});
