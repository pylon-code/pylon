import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./ProviderStatusBanner";

function warningProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-23T12:00:00.000Z",
    message: "Provider is temporarily degraded.",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("ProviderStatusBanner", () => {
  it("stays hidden after its current warning is dismissed", () => {
    const status = warningProvider();

    expect(shouldShowProviderStatusBanner(status, null)).toBe(true);
    expect(shouldShowProviderStatusBanner(status, getProviderStatusBannerKey(status))).toBe(false);
  });

  it("renders an accessible dismiss control for provider warnings", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() => {}} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss Codex provider warning"');
    expect(markup).toContain("absolute top-2 right-2");
    expect(markup).toContain("line-clamp-3");
    expect(markup).toContain('data-slot="tooltip-trigger"');
  });

  it("renders on a glass surface so the timeline never reads through the banner", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() => {}} />,
    );

    expect(markup).toContain("alert-glass");
    expect(markup).toContain('data-variant="warning"');
  });

  it("labels error dismiss controls with the correct severity", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={{ ...warningProvider(), status: "error" }}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Dismiss Codex provider error"');
  });

  it("shows an unavailable WSL2 reason even when the shadow status is disabled", () => {
    const reason =
      "Prime Agent is unavailable because this Pylon server is running on native Windows. Run the Pylon server and Prime Agent in WSL2, or connect this client to a Pylon server running in WSL2 or another remote environment.";
    const status: ServerProvider = {
      ...warningProvider(),
      instanceId: ProviderInstanceId.make("primeAgent"),
      driver: ProviderDriverKind.make("primeAgent"),
      displayName: "Prime Agent",
      enabled: false,
      installed: false,
      status: "disabled",
      availability: "unavailable",
      unavailableReason: reason,
      message: reason,
      auth: { status: "unknown" },
    };
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={status} onDismiss={() => {}} />,
    );

    expect(shouldShowProviderStatusBanner(status, null)).toBe(true);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Prime Agent is unavailable");
    expect(markup).toContain(reason);
    expect(markup).toContain("whitespace-pre-wrap");
    expect(markup).not.toContain("line-clamp-3");
    expect(markup).not.toContain('data-slot="tooltip-trigger"');
    expect(markup).toContain('aria-label="Dismiss Prime Agent provider unavailable"');
    expect(markup).toContain('data-variant="error"');
  });

  it("keeps an ordinary disabled provider hidden", () => {
    const status: ServerProvider = {
      ...warningProvider(),
      enabled: false,
      status: "disabled",
    };

    expect(getProviderStatusBannerKey(status)).toBeNull();
    expect(shouldShowProviderStatusBanner(status, null)).toBe(false);
    expect(
      renderToStaticMarkup(<ProviderStatusBanner status={status} onDismiss={() => {}} />),
    ).toBe("");
  });
});
