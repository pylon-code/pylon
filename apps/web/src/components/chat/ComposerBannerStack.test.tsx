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

  it("keeps the details popover out of a compact banner until the row is narrow", () => {
    // A compact banner's description is short enough to stay on screen, so the
    // popover trigger only appears once the row is too narrow to show it.
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[item("clone", { description: "Finishing an update", compact: true })]}
      />,
    );

    expect(markup).toContain('data-composer-banner-layout="wrap-actions-narrow"');
    expect(markup).toContain("@max-[400px]:inline-flex");
  });

  it("always offers the details popover on a banner that can truncate", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          item("notice", {
            description: "A description long enough to truncate on a narrow composer",
          }),
        ]}
      />,
    );

    expect(markup).toContain('data-composer-banner-layout="wrap-actions"');
    expect(markup).not.toContain("@max-[400px]:inline-flex");
  });

  it("renders no details popover when a banner has no description", () => {
    const markup = renderToStaticMarkup(<ComposerBannerStack items={[item("bare")]} />);

    expect(markup).not.toContain("Show notice details");
  });
});
