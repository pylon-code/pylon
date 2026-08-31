import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";

function item(
  id: string,
  overrides: Partial<ComposerBannerStackItem> = {},
): ComposerBannerStackItem {
  return { id, variant: "default", icon: null, title: id, ...overrides };
}

describe("ComposerBannerStack", () => {
  it("renders nothing without items", () => {
    expect(renderToStaticMarkup(<ComposerBannerStack items={[]} />)).toBe("");
  });

  it("puts activity items in front of ordinary notices", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[item("plain-notice"), item("liveness", { priority: "activity" })]}
      />,
    );

    expect(markup.indexOf("liveness")).toBeLessThan(markup.indexOf("plain-notice"));
  });

  it("keeps array order between two activity items", () => {
    // Background liveness and the composer's own status share this priority.
    // The Stop button on the first is the only stop affordance for a settled
    // turn, so whichever the caller lists first must stay front-most.
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          item("liveness", { priority: "activity" }),
          item("composer-activity", { priority: "activity" }),
        ]}
      />,
    );

    expect(markup.indexOf("liveness")).toBeLessThan(markup.indexOf("composer-activity"));
  });
});
