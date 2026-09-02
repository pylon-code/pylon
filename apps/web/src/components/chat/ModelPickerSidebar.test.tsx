import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { ModelPickerSidebar } from "./ModelPickerSidebar";

function entry(input: {
  readonly enabled: boolean;
  readonly availability?: ServerProvider["availability"];
  readonly reason?: string;
}): ProviderInstanceEntry {
  const [derived] = deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("primeAgent"),
      driver: ProviderDriverKind.make("primeAgent"),
      displayName: "Prime Agent",
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      ...(input.availability ? { availability: input.availability } : {}),
      ...(input.reason ? { unavailableReason: input.reason, message: input.reason } : {}),
      auth: { status: "unknown" },
      checkedAt: "2026-08-28T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  if (!derived) throw new Error("expected provider entry");
  return { ...derived, enabled: input.enabled };
}

function renderEntry(providerEntry: ProviderInstanceEntry): string {
  return renderToStaticMarkup(
    <ModelPickerSidebar
      selectedInstanceId={providerEntry.instanceId}
      onSelectInstance={() => undefined}
      instanceEntries={[providerEntry]}
      showFavorites={false}
    />,
  );
}

describe("ModelPickerSidebar unavailable provider presentation", () => {
  it("shows the WSL2 reason ahead of a fail-closed disabled snapshot", () => {
    const reason =
      "Prime Agent is unavailable because this Pylon server is running on native Windows. Run the Pylon server and Prime Agent in WSL2, or connect this client to a Pylon server running in WSL2 or another remote environment.";
    // Settings can still express enabled intent while the server publishes an
    // unavailable, disabled shadow. The rail must remain non-selectable.
    const markup = renderEntry(entry({ enabled: true, availability: "unavailable", reason }));

    expect(markup).toContain("Unavailable");
    expect(markup).toContain(reason);
    expect(markup).not.toContain("Disabled in settings");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('aria-describedby="model-picker-provider-primeAgent-disabled-reason"');
    expect(markup).toContain('class="sr-only"');
    expect(markup).toContain('aria-hidden="true" tabindex="-1"');
  });

  it("keeps ordinary disabled copy when availability is not unavailable", () => {
    const markup = renderEntry(entry({ enabled: false }));

    expect(markup).toContain("Disabled in settings");
    expect(markup).not.toContain("Unavailable.");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("model-picker-provider-primeAgent-disabled-reason");
  });
});
