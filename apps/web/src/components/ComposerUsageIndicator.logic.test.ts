import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatTimeUntilReset, getComposerUsageView } from "./ComposerUsageIndicator.logic";

function provider(input: {
  windows?: ReadonlyArray<ServerProviderUsageWindow>;
  displayName?: string;
  accentColor?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(input.windows
      ? {
          usageLimits: {
            source: "claudeOAuth",
            checkedAt: "2026-08-04T21:00:00.000Z",
            windows: input.windows,
          },
        }
      : {}),
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt: "2026-08-04T21:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
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
    const view = getComposerUsageView(provider({ windows: CLAUDE_WINDOWS }), NOW);

    expect(view?.entries).toEqual([
      {
        // Reset already passed, so it falls back to the window's length
        // rather than showing a countdown that has run out.
        label: "5h",
        remainingPercent: 86,
        detail: "Session",
        resetsAt: "2026-08-05T01:00:00.000Z",
      },
      {
        label: "3d 5h",
        remainingPercent: 60,
        detail: "Weekly (all models)",
        resetsAt: "2026-08-09T17:00:00.000Z",
      },
    ]);
  });

  // The strip is a glance; the popover carries the model-scoped weeklies.
  it("leaves model-scoped weeklies out", () => {
    const view = getComposerUsageView(provider({ windows: CLAUDE_WINDOWS }), NOW);

    expect(view?.entries.some((entry) => entry.detail === "Weekly (Fable)")).toBe(false);
  });

  // Windows are matched on duration, so Codex's differently-named ones work.
  it("reads Codex's window labels", () => {
    const view = getComposerUsageView(
      provider({
        windows: [
          { label: "Session", usedPercent: 25, windowDurationMins: 300 },
          { label: "Weekly", usedPercent: 82, windowDurationMins: 10_080 },
        ],
      }),
      NOW,
    );

    // No reset reported, so the label falls back to the window's length.
    expect(view?.entries.map((entry) => `${entry.label} ${entry.remainingPercent}`)).toEqual([
      "5h 75",
      "7d 18",
    ]);
  });

  it("rounds a fractional percentage", () => {
    const view = getComposerUsageView(
      provider({ windows: [{ label: "Session", usedPercent: 14.6, windowDurationMins: 300 }] }),
      NOW,
    );

    expect(view?.entries[0]?.remainingPercent).toBe(85);
  });

  it("carries the account name and accent for the tooltip and dot", () => {
    const view = getComposerUsageView(
      provider({ windows: CLAUDE_WINDOWS, displayName: "Claude Work", accentColor: "#0088ff" }),
      NOW,
    );

    expect(view?.accountName).toBe("Claude Work");
    expect(view?.accentColor).toBe("#0088ff");
  });

  it("renders one entry when only a session window is reported", () => {
    const view = getComposerUsageView(
      provider({ windows: [{ label: "Session", usedPercent: 5, windowDurationMins: 300 }] }),
      NOW,
    );

    expect(view?.entries).toHaveLength(1);
    expect(view?.entries[0]?.label).toBe("5h");
  });

  // Nothing to say beats a placeholder in a strip this dense.
  it.each([
    ["no provider", null],
    ["a provider with no usage", provider({})],
    ["a provider reporting zero windows", provider({ windows: [] })],
    [
      "windows with no duration to classify",
      provider({ windows: [{ label: "Mystery", usedPercent: 10 }] }),
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
