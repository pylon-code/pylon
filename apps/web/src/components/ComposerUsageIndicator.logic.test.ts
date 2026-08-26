import { ProviderInstanceId, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatTimeUntilReset, getComposerUsageView } from "./ComposerUsageIndicator.logic";
import type { ProviderUsageAccount } from "./providerUsage/ProviderUsageAccounts";

function account(input: {
  windows: ReadonlyArray<ServerProviderUsageWindow>;
  displayName?: string;
  accentColor?: string;
  checkedAt?: string;
}): ProviderUsageAccount {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    displayName: input.displayName ?? "Claude",
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    usageLimits: {
      source: "claudeOAuth",
      checkedAt: input.checkedAt ?? "2026-08-06T11:59:00.000Z",
      windows: input.windows,
    },
    isActive: true,
  };
}

// Shaped like what the OAuth endpoint produces: session, account-wide weekly,
// then a model-scoped weekly.
const CLAUDE_WINDOWS = [
  {
    label: "Session",
    usedPercent: 14,
    windowDurationMins: 300,
    resetsAt: "2026-08-05T01:00:00.000Z",
  },
  {
    label: "Weekly (all models)",
    usedPercent: 40,
    windowDurationMins: 10_080,
    resetsAt: "2026-08-09T17:00:00.000Z",
  },
  {
    label: "Weekly (Fable)",
    usedPercent: 12,
    windowDurationMins: 10_080,
    resetsAt: "2026-08-09T17:00:00.000Z",
  },
];

const NOW = Date.parse("2026-08-06T12:00:00.000Z");

describe("getComposerUsageView", () => {
  it("shows the session and account-wide weekly only", () => {
    const view = getComposerUsageView(account({ windows: CLAUDE_WINDOWS }), NOW);

    expect(view?.entries).toEqual([
      {
        // Reset already passed, so it falls back to the window's length
        // rather than showing a countdown that has run out.
        label: "5h",
        usedPercent: 14,
        detail: "Session",
        resetsAt: "2026-08-05T01:00:00.000Z",
      },
      {
        label: "3d 5h",
        usedPercent: 40,
        detail: "Weekly (all models)",
        resetsAt: "2026-08-09T17:00:00.000Z",
      },
    ]);
  });

  // The strip is a glance; the popover carries the model-scoped weeklies.
  it("leaves model-scoped weeklies out", () => {
    const view = getComposerUsageView(account({ windows: CLAUDE_WINDOWS }), NOW);

    expect(view?.entries.some((entry) => entry.detail === "Weekly (Fable)")).toBe(false);
  });

  // Windows are matched on duration, so Codex's differently-named ones work.
  it("reads Codex's window labels", () => {
    const view = getComposerUsageView(
      account({
        windows: [
          { label: "Session", usedPercent: 25, windowDurationMins: 300 },
          { label: "Weekly", usedPercent: 82, windowDurationMins: 10_080 },
        ],
      }),
      NOW,
    );

    // No reset reported, so the label falls back to the window's length.
    expect(view?.entries.map((entry) => `${entry.label} ${entry.usedPercent}`)).toEqual([
      "5h 25",
      "7d 82",
    ]);
  });

  it("rounds a fractional percentage", () => {
    const view = getComposerUsageView(
      account({ windows: [{ label: "Session", usedPercent: 14.6, windowDurationMins: 300 }] }),
      NOW,
    );

    expect(view?.entries[0]?.usedPercent).toBe(15);
  });

  it("carries the account name and accent for the tooltip and dot", () => {
    const view = getComposerUsageView(
      account({ windows: CLAUDE_WINDOWS, displayName: "Claude Work", accentColor: "#0088ff" }),
      NOW,
    );

    expect(view?.accountName).toBe("Claude Work");
    expect(view?.accentColor).toBe("#0088ff");
  });

  it("renders one entry when only a session window is reported", () => {
    const view = getComposerUsageView(
      account({ windows: [{ label: "Session", usedPercent: 5, windowDurationMins: 300 }] }),
      NOW,
    );

    expect(view?.entries).toHaveLength(1);
    expect(view?.entries[0]?.label).toBe("5h");
  });

  // Dimming is the strip's whole way of admitting a number has fallen behind
  // the server's own poll, so the bound must track that poll.
  it("marks a reading stale only past the caller's bound", () => {
    const aged = account({ windows: CLAUDE_WINDOWS, checkedAt: "2026-08-06T11:54:00.000Z" });

    expect(getComposerUsageView(aged, NOW, 5 * 60_000)?.stale).toBe(true);
    expect(getComposerUsageView(aged, NOW, 10 * 60_000)?.stale).toBe(false);
    expect(getComposerUsageView(aged, NOW)?.age).toBe("6m");
  });

  it("has no age for a reading under a minute old", () => {
    const view = getComposerUsageView(
      account({ windows: CLAUDE_WINDOWS, checkedAt: "2026-08-06T11:59:30.000Z" }),
      NOW,
    );

    expect(view?.age).toBeUndefined();
    expect(view?.stale).toBe(false);
  });

  // Nothing to say beats a placeholder in a strip this dense.
  it.each([
    ["no account", null],
    ["an account reporting zero windows", account({ windows: [] })],
    [
      "windows with no duration to classify",
      account({ windows: [{ label: "Mystery", usedPercent: 10 }] }),
    ],
  ])("returns null for %s", (_label, input) => {
    expect(getComposerUsageView(input, NOW)).toBeNull();
  });
});

describe("formatTimeUntilReset", () => {
  // The countdown is the point of the label: "5h" never changes and settles
  // nothing, "1h 45m" answers whether to keep going or wait.
  it.each([
    ["1h 45m", 105 * 60_000],
    ["45m", 45 * 60_000],
    ["2h", 120 * 60_000],
    ["3d 5h", 3 * 24 * 60 * 60_000 + 5 * 60 * 60_000],
    ["6d", 6 * 24 * 60 * 60_000],
  ])("renders %s", (expected, offsetMs) => {
    expect(formatTimeUntilReset(new Date(NOW + offsetMs).toISOString(), NOW)).toBe(expected);
  });

  // Never zero or negative: a window that has reset has no countdown left to
  // show, and the caller falls back to the window's length.
  it("gives nothing once the reset has passed", () => {
    expect(formatTimeUntilReset(new Date(NOW - 60_000).toISOString(), NOW)).toBeUndefined();
    expect(formatTimeUntilReset(new Date(NOW).toISOString(), NOW)).toBeUndefined();
  });

  // Under a minute still reads as a minute rather than "0m", which would look
  // like a stuck clock.
  it("floors to one minute rather than showing zero", () => {
    expect(formatTimeUntilReset(new Date(NOW + 20_000).toISOString(), NOW)).toBe("1m");
  });

  it("gives nothing for an unreadable timestamp", () => {
    expect(formatTimeUntilReset("not a date", NOW)).toBeUndefined();
  });
});
