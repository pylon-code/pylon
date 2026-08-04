import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getComposerUsageView } from "./ComposerUsageIndicator.logic";

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

describe("getComposerUsageView", () => {
  it("shows the session and account-wide weekly only", () => {
    const view = getComposerUsageView(provider({ windows: CLAUDE_WINDOWS }));

    expect(view?.entries).toEqual([
      {
        label: "5h",
        usedPercent: 14,
        detail: "Session",
        resetsAt: "2026-08-05T01:00:00.000Z",
      },
      {
        label: "7d",
        usedPercent: 40,
        detail: "Weekly (all models)",
        resetsAt: "2026-08-09T17:00:00.000Z",
      },
    ]);
  });

  // The strip is a glance; the popover carries the model-scoped weeklies.
  it("leaves model-scoped weeklies out", () => {
    const view = getComposerUsageView(provider({ windows: CLAUDE_WINDOWS }));

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
    );

    expect(view?.entries.map((entry) => `${entry.label} ${entry.usedPercent}`)).toEqual([
      "5h 25",
      "7d 82",
    ]);
  });

  it("rounds a fractional percentage", () => {
    const view = getComposerUsageView(
      provider({ windows: [{ label: "Session", usedPercent: 14.6, windowDurationMins: 300 }] }),
    );

    expect(view?.entries[0]?.usedPercent).toBe(15);
  });

  it("carries the account name and accent for the tooltip and dot", () => {
    const view = getComposerUsageView(
      provider({ windows: CLAUDE_WINDOWS, displayName: "Claude Work", accentColor: "#0088ff" }),
    );

    expect(view?.accountName).toBe("Claude Work");
    expect(view?.accentColor).toBe("#0088ff");
  });

  it("renders one entry when only a session window is reported", () => {
    const view = getComposerUsageView(
      provider({ windows: [{ label: "Session", usedPercent: 5, windowDurationMins: 300 }] }),
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
    expect(getComposerUsageView(input)).toBeNull();
  });
});
