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
});
