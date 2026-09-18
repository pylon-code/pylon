import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderUsageRows, ProviderUsageSummary } from "./ProviderUsageRows";

describe("ProviderUsageRows", () => {
  it("renders dynamic windows with explicit used percentages", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageRows
        timestampFormat="24-hour"
        usageLimits={{
          source: "claudePrint",
          checkedAt: "2026-07-22T12:00:00.000Z",
          windows: [
            { label: "Session", usedPercent: 30 },
            { label: "Weekly (Fable)", usedPercent: 26 },
          ],
        }}
      />,
    );

    expect(markup).toContain("Session");
    expect(markup).toContain("30% used");
    expect(markup).toContain("Weekly (Fable)");
    expect(markup).toContain("26% used");
  });

  it("renders multiple windows as one compact used summary", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageSummary
        usageLimits={{
          source: "claudePrint",
          checkedAt: "2026-07-22T12:00:00.000Z",
          windows: [
            { label: "Session", usedPercent: 84 },
            { label: "Weekly (all models)", usedPercent: 20 },
            { label: "Weekly (Fable)", usedPercent: 32 },
          ],
        }}
      />,
    );

    expect(markup).toContain("Session");
    expect(markup).toContain("84%");
    expect(markup).toContain("Weekly (all models)");
    expect(markup).toContain("20%");
    expect(markup).toContain("Weekly (Fable)");
    expect(markup).toContain("32%");
    expect(markup).toContain("used");
    expect(markup).toContain("·");
  });

  it("renders unavailable usage limits message cleanly when unsupported or empty", () => {
    const rows = renderToStaticMarkup(
      <ProviderUsageRows
        timestampFormat="24-hour"
        usageLimits={{
          source: "provider",
          checkedAt: "2026-07-22T12:00:00.000Z",
          windows: [],
          unavailable: {
            reason: "unsupported",
            message: "Rate limits are not available for this account.",
          },
        }}
      />,
    );
    expect(rows).toContain("Rate limits are not available for this account.");

    const summary = renderToStaticMarkup(
      <ProviderUsageSummary
        usageLimits={{
          source: "provider",
          checkedAt: "2026-07-22T12:00:00.000Z",
          windows: [],
          unavailable: {
            reason: "unsupported",
            message: "Rate limits are not available for this account.",
          },
        }}
      />,
    );
    expect(summary).toContain("Rate limits are not available for this account.");
  });

  it("retains last known valid bars when probeFailed", () => {
    const rows = renderToStaticMarkup(
      <ProviderUsageRows
        timestampFormat="24-hour"
        usageLimits={{
          source: "provider",
          checkedAt: "2026-07-22T12:00:00.000Z",
          windows: [
            { label: "5-Hour (Gemini)", usedPercent: 50 },
            { label: "Weekly (Gemini)", usedPercent: 10 },
          ],
          unavailable: {
            reason: "probeFailed",
            message: "Antigravity usage limits could not be refreshed.",
          },
        }}
      />,
    );
    // Bars are still rendered
    expect(rows).toContain("5-Hour (Gemini)");
    expect(rows).toContain("50% used");
    expect(rows).toContain("Weekly (Gemini)");
    expect(rows).toContain("10% used");
    // And error message is surfaced
    expect(rows).toContain("Antigravity usage limits could not be refreshed.");

    const summary = renderToStaticMarkup(
      <ProviderUsageSummary
        usageLimits={{
          source: "provider",
          checkedAt: "2026-07-22T12:00:00.000Z",
          windows: [
            { label: "5-Hour (Gemini)", usedPercent: 50 },
            { label: "Weekly (Gemini)", usedPercent: 10 },
          ],
          unavailable: {
            reason: "probeFailed",
            message: "Antigravity usage limits could not be refreshed.",
          },
        }}
      />,
    );
    expect(summary).toContain("5-Hour (Gemini)");
    expect(summary).toContain("50%");
    expect(summary).toContain("Weekly (Gemini)");
    expect(summary).toContain("10%");
  });
});
