import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderUsageAccounts, type ProviderUsageAccount } from "./ProviderUsageAccounts";

function account(overrides: Partial<ProviderUsageAccount> = {}): ProviderUsageAccount {
  return {
    instanceId: "claudeAgent",
    displayName: "Personal",
    usageLimits: {
      source: "claudePrint",
      checkedAt: "2026-07-22T12:00:00.000Z",
      windows: [{ label: "Session", usedPercent: 30 }],
    },
    isActive: true,
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-06T12:00:00.000Z");

describe("ProviderUsageAccounts", () => {
  it("renders nothing when no account reports usage", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageAccounts accounts={[]} timestampFormat="24-hour" nowMs={NOW} />,
    );

    expect(markup).toBe("");
  });

  // A single configured account has nothing to disambiguate, so the section
  // should read exactly as upstream's single-instance list — no account header.
  it("omits the account header when only one account is configured", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageAccounts accounts={[account()]} timestampFormat="24-hour" nowMs={NOW} />,
    );

    expect(markup).toContain("30% used");
    expect(markup).not.toContain("Personal");
    expect(markup).not.toContain("this thread");
  });

  it("labels each account and marks the one the thread is bound to", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageAccounts
        timestampFormat="24-hour"
        nowMs={NOW}
        accounts={[
          account({ instanceId: "claude_personal", displayName: "Personal", isActive: true }),
          account({
            instanceId: "claude_work",
            displayName: "Work",
            isActive: false,
            usageLimits: {
              source: "claudePrint",
              checkedAt: "2026-07-22T12:00:00.000Z",
              windows: [{ label: "Session", usedPercent: 5 }],
            },
          }),
        ]}
      />,
    );

    expect(markup).toContain("Personal");
    expect(markup).toContain("Work");
    expect(markup).toContain("30% used");
    expect(markup).toContain("5% used");
    // Only the bound account carries the marker.
    expect(markup.match(/this thread/g)).toHaveLength(1);
  });

  // Staleness belongs to the probe, not to the account, so it has to be able to
  // appear on the account the thread is bound to. The older markup put "this
  // thread" and the staleness note in the same slot, which made an active stale
  // reading silently unreportable.
  it("reports a stale reading on the active account alongside its marker", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageAccounts
        timestampFormat="24-hour"
        nowMs={NOW}
        accounts={[
          account({
            instanceId: "claude_personal",
            displayName: "Personal",
            isActive: true,
            usageLimits: {
              source: "claudePrint",
              // Eight minutes before NOW: past the staleness threshold.
              checkedAt: "2026-08-06T11:52:00.000Z",
              windows: [{ label: "Session", usedPercent: 30 }],
            },
          }),
          account({ instanceId: "claude_work", displayName: "Work", isActive: false }),
        ]}
      />,
    );

    expect(markup).toContain("this thread");
    expect(markup).toContain("8m old");
  });

  // A reading younger than a minute has no age worth printing, and "0m ago"
  // reads as a bug.
  it("says nothing about age for a reading taken just now", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageAccounts
        timestampFormat="24-hour"
        nowMs={NOW}
        accounts={[
          account({
            instanceId: "claude_personal",
            isActive: true,
            usageLimits: {
              source: "claudePrint",
              checkedAt: new Date(NOW - 20_000).toISOString(),
              windows: [{ label: "Session", usedPercent: 30 }],
            },
          }),
          account({
            instanceId: "claude_work",
            displayName: "Work",
            isActive: false,
            usageLimits: {
              source: "claudePrint",
              checkedAt: new Date(NOW - 20_000).toISOString(),
              windows: [{ label: "Session", usedPercent: 5 }],
            },
          }),
        ]}
      />,
    );

    expect(markup).not.toContain(" old");
    expect(markup).not.toContain("Last successful reading");
  });

  it("carries each account's accent color onto its marker", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageAccounts
        timestampFormat="24-hour"
        nowMs={NOW}
        accounts={[
          account({ instanceId: "claude_personal", accentColor: "#2563eb", isActive: true }),
          account({ instanceId: "claude_work", displayName: "Work", isActive: false }),
        ]}
      />,
    );

    expect(markup).toContain("#2563eb");
  });
});
