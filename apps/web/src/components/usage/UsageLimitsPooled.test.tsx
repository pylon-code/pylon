import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => ({}) }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../settings/providerDriverMeta", () => ({ getDriverOption: () => ({ label: "Cursor" }) }));
vi.mock("./UsageLimits", () => ({
  PaceIcon: () => null,
  ResetCreditDialog: () => null,
  barColor: () => "#000",
  resetCreditsSummary: () => null,
  useResetCredit: () => ({}),
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  PopoverPopup: () => null,
}));

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const now = Date.parse("2026-09-03T12:00:00Z");
const windows: readonly ServerProviderUsageWindow[] = [
  { id: "totalPercentUsed", kind: "monthly", label: "Monthly", usedPercent: 15 },
  { id: "apiPercentUsed", kind: "monthly", label: "Monthly · API", usedPercent: 49 },
  { id: "autoPercentUsed", kind: "monthly", label: "Monthly · Auto", usedPercent: 9 },
];
function provider(readings = windows, id = "cursor") {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: `${id}@example.com` },
    checkedAt: "2026-09-03T11:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-09-03T11:00:00Z", windows: readings },
  } satisfies ServerProvider;
}
function render(providers: readonly ServerProvider[]) {
  const presentations = new Map([
    [
      EnvironmentId.make("desktop"),
      { entry: { target: { label: "Desktop" } }, serverConfig: { providers } },
    ],
  ]);
  return renderToStaticMarkup(<UsageLimitsPooled presentations={presentations} now={now} />);
}

describe("Cursor Limits cards", () => {
  it("uses existing readings to explain both usable pools without showing a third quota", () => {
    const markup = render([provider()]);
    expect(markup).toContain("Cursor Models");
    expect(markup).toContain("Other Models");
    expect(markup).toContain("Auto can use either pool.");
    expect(markup).not.toContain(">Overall<");
    expect(markup).not.toContain(">Monthly<");
    expect(markup.indexOf("Cursor Models")).toBeLessThan(markup.indexOf("Other Models"));
  });
  it("keeps combined-only accounts and unfamiliar readings visible", () => {
    const markup = render([
      provider(),
      provider(
        [windows[0]!, { id: "future", kind: "other", label: "Future allowance", usedPercent: 20 }],
        "older",
      ),
    ]);
    expect(markup).toContain(">Overall<");
    expect(markup).toContain("Combined usage across both allowances, not a third quota.");
    expect(markup).toContain("Future allowance");
  });
});
