import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { formatDrainResetLabel, getAccountDrainPillView } from "./SidebarAccountDrainPill.logic";

const NOW_MS = Date.parse("2026-08-04T18:00:00.000Z");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

function provider(input: {
  instanceId: string;
  displayName?: string;
  accentColor?: string;
  drainedUntil?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: CLAUDE,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(input.drainedUntil
      ? {
          rateLimit: {
            status: "rejected" as const,
            rateLimitType: "five_hour",
            observedAt: "2026-08-04T17:00:00.000Z",
            resetsAt: input.drainedUntil,
          },
        }
      : {}),
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt: "2026-08-04T17:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

/** Entries as the sidebar builds them, with drain priority applied from settings. */
function entriesFor(
  snapshots: ReadonlyArray<ServerProvider>,
  priorities: Readonly<Record<string, number>> = {},
): ReadonlyArray<ProviderInstanceEntry> {
  return applyProviderInstanceSettings(deriveProviderInstanceEntries(snapshots), {
    providerInstances: Object.fromEntries(
      snapshots.map((snapshot) => [
        snapshot.instanceId,
        {
          driver: CLAUDE,
          ...(priorities[snapshot.instanceId] !== undefined
            ? { priority: priorities[snapshot.instanceId] }
            : {}),
        },
      ]),
    ),
    providers: {} as never,
  });
}

describe("formatDrainResetLabel", () => {
  it.each([
    ["2026-08-04T18:00:30.000Z", "in under a minute"],
    ["2026-08-04T18:45:00.000Z", "in 45m"],
    ["2026-08-04T21:30:00.000Z", "in 3h"],
    ["2026-08-08T18:00:00.000Z", "in 4d"],
  ])("formats %s as %s", (resetsAt, expected) => {
    expect(formatDrainResetLabel(resetsAt, NOW_MS)).toBe(expected);
  });

  // A per-second countdown is the one thing this label must never become.
  it("never renders seconds", () => {
    expect(formatDrainResetLabel("2026-08-04T18:00:42.000Z", NOW_MS)).not.toMatch(/\d+s/u);
  });

  it("returns nothing for an unparseable reset time", () => {
    expect(formatDrainResetLabel("not-a-date", NOW_MS)).toBe("");
  });
});

describe("getAccountDrainPillView", () => {
  it("renders nothing while every account can serve a turn", () => {
    const entries = entriesFor([
      provider({ instanceId: "claude_primary" }),
      provider({ instanceId: "claude_backup" }),
    ]);

    expect(getAccountDrainPillView(entries, NOW_MS)).toBeNull();
  });

  it("renders nothing once the drained window has reset", () => {
    const entries = entriesFor([
      provider({ instanceId: "claude_primary", drainedUntil: "2026-08-04T17:30:00.000Z" }),
    ]);

    expect(getAccountDrainPillView(entries, NOW_MS)).toBeNull();
  });

  it("names the account that took over and when the spent one returns", () => {
    const entries = entriesFor(
      [
        provider({
          instanceId: "claude_primary",
          displayName: "Personal",
          accentColor: "#ff8800",
          drainedUntil: "2026-08-04T21:00:00.000Z",
        }),
        provider({ instanceId: "claude_backup", displayName: "Work", accentColor: "#0088ff" }),
      ],
      { claude_primary: 0, claude_backup: 1 },
    );

    const view = getAccountDrainPillView(entries, NOW_MS);

    expect(view?.title).toBe("On Work");
    expect(view?.description).toBe(
      "Personal is out of capacity and resets in 3h. New threads are opening on Work.",
    );
    expect(view?.spent.accentColor).toBe("#ff8800");
    expect(view?.takeover?.accentColor).toBe("#0088ff");
  });

  it("says so when no other account can pick the work up", () => {
    const entries = entriesFor([
      provider({
        instanceId: "claude_primary",
        displayName: "Personal",
        drainedUntil: "2026-08-04T21:00:00.000Z",
      }),
    ]);

    const view = getAccountDrainPillView(entries, NOW_MS);

    expect(view?.title).toBe("Personal is spent");
    expect(view?.description).toContain("No other account is configured for it");
    expect(view?.takeover).toBeUndefined();
  });

  it("reports the highest-priority drained account when several are spent", () => {
    const entries = entriesFor(
      [
        provider({
          instanceId: "claude_backup",
          displayName: "Work",
          drainedUntil: "2026-08-04T22:00:00.000Z",
        }),
        provider({
          instanceId: "claude_primary",
          displayName: "Personal",
          drainedUntil: "2026-08-04T21:00:00.000Z",
        }),
      ],
      { claude_primary: 0, claude_backup: 1 },
    );

    const view = getAccountDrainPillView(entries, NOW_MS);

    expect(view?.title).toBe("Personal is spent");
    expect(view?.takeover).toBeUndefined();
  });

  // The key identifies the situation, so a minute tick re-labels the pill
  // without remounting it.
  it("keeps a stable key as the reset time counts down", () => {
    const entries = entriesFor([
      provider({
        instanceId: "claude_primary",
        displayName: "Personal",
        drainedUntil: "2026-08-04T21:00:00.000Z",
      }),
      provider({ instanceId: "claude_backup", displayName: "Work" }),
    ]);

    const early = getAccountDrainPillView(entries, NOW_MS);
    const later = getAccountDrainPillView(entries, NOW_MS + 60_000);

    expect(later?.key).toBe(early?.key);
    expect(later?.description).not.toBe(early?.description);
  });

  it("ignores a disabled account", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ instanceId: "claude_primary", drainedUntil: "2026-08-04T21:00:00.000Z" }),
    ]).map((entry) => ({ ...entry, enabled: false }));

    expect(getAccountDrainPillView(entries, NOW_MS)).toBeNull();
  });
});
