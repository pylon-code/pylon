import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Combobox } from "../ui/combobox";
import { ModelListRow } from "./ModelListRow";

function renderRow(disabledReason?: string) {
  return renderToStaticMarkup(
    <Combobox open>
      <ModelListRow
        index={0}
        model={{ slug: "default", name: "Prime Agent Default" }}
        instanceId={ProviderInstanceId.make("primeAgent")}
        driverKind={ProviderDriverKind.make("primeAgent")}
        providerDisplayName="Prime Agent"
        isFavorite={false}
        isSelected={false}
        showProvider
        disabledReason={disabledReason ?? null}
        onToggleFavorite={() => undefined}
      />
    </Combobox>,
  );
}

describe("ModelListRow", () => {
  it("puts the disabled reason on the actual option and preserves its disabled semantics", () => {
    const reason = "Start a new thread to use Prime Agent Default.";
    const html = renderRow(reason);
    const option = html.match(/<[^>]+role="option"[^>]*>/)?.[0];

    expect(option).toBeDefined();
    expect(option).toContain('aria-disabled="true"');
    expect(option).toContain(`title="${reason}"`);
  });

  it("leaves an available option enabled without a disabled title", () => {
    const html = renderRow();
    const option = html.match(/<[^>]+role="option"[^>]*>/)?.[0];

    expect(option).toBeDefined();
    expect(option).not.toContain('aria-disabled="true"');
    expect(option).not.toContain("title=");
  });
});
