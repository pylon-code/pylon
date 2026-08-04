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

describe("ProviderUsageAccounts", () => {
  it("renders nothing when no account reports usage", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageAccounts accounts={[]} timestampFormat="24-hour" />,
    );

    expect(markup).toBe("");
  });

  // A single configured account has nothing to disambiguate, so the section
  // should read exactly as upstream's single-instance list — no account header.
  it("omits the account header when only one account is configured", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageAccounts accounts={[account()]} timestampFormat="24-hour" />,
    );

    expect(markup).toContain("70% remaining");
    expect(markup).not.toContain("Personal");
    expect(markup).not.toContain("this thread");
  });

  it("labels each account and marks the one the thread is bound to", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageAccounts
        timestampFormat="24-hour"
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
    expect(markup).toContain("70% remaining");
    expect(markup).toContain("95% remaining");
    // Only the bound account carries the marker.
    expect(markup.match(/this thread/g)).toHaveLength(1);
  });

  it("carries each account's accent color onto its marker", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageAccounts
        timestampFormat="24-hour"
        accounts={[
          account({ instanceId: "claude_personal", accentColor: "#2563eb", isActive: true }),
          account({ instanceId: "claude_work", displayName: "Work", isActive: false }),
        ]}
      />,
    );

    expect(markup).toContain("#2563eb");
  });
});
