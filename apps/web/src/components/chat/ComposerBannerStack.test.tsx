import { cloneElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";

function item(
  id: string,
  overrides: Partial<ComposerBannerStackItem> = {},
): ComposerBannerStackItem {
  return { id, variant: "default", icon: null, title: id, ...overrides };
}

describe("ComposerBannerStack ordering", () => {
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

vi.mock("../ui/popover", () => ({
  Popover: "popover",
  PopoverTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  PopoverPopup: "popup",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));

let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("only offers notice details when the description cannot fit", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resize = () => {};
  let mutate = () => {};
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mutate = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  let position = "static";
  vi.stubGlobal("getComputedStyle", () => ({ position }));
  let availableWidth = 200;
  const nested = { clientWidth: 100, scrollWidth: 80 };
  const text = {
    querySelectorAll: () => [nested],
    get clientWidth() {
      return (
        availableWidth -
        (renderer?.root.findAllByProps({ "aria-label": "Show notice details" }).length ? 28 : 0)
      );
    },
    scrollWidth: 80,
  };
  await act(() => {
    renderer = create(
      <ComposerBannerStack
        items={[
          {
            id: "usage",
            variant: "info",
            icon: null,
            title: "Usage limits",
            description: "OpenCode",
          },
        ]}
      />,
      {
        createNodeMock: (element) =>
          element.type === "span" ? text : element.type === "button" ? { offsetWidth: 24 } : null,
      },
    );
  });
  const details = () => renderer.root.findAllByProps({ "aria-label": "Show notice details" });
  expect(details()).toHaveLength(0);
  text.scrollWidth = 300;
  await act(() => resize());
  expect(details()).toHaveLength(1);
  // It fits without the icon: the icon must not keep its own overflow alive.
  availableWidth = 308;
  await act(() => resize());
  expect(details()).toHaveLength(0);
  text.scrollWidth = 80;
  await act(() => resize());
  expect(details()).toHaveLength(0);
  nested.scrollWidth = 500;
  await act(() => mutate());
  expect(details()).toHaveLength(1);
  nested.scrollWidth = 80;
  await act(() => mutate());
  expect(details()).toHaveLength(0);
  position = "absolute";
  await act(() => resize());
  expect(details()).toHaveLength(1);
  position = "static";
  await act(() => resize());
  expect(details()).toHaveLength(0);
});
