import { act, createRef } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("lets gallery arrows pass when a zoomed image has no horizontal pan", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const viewport = {
    scrollWidth: 400,
    offsetWidth: 400,
    scrollLeft: 0,
    scrollTop: 0,
    clientWidth: 400,
    clientHeight: 300,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const ref = createRef<ZoomableImageHandle>();
  await act(() => {
    renderer = create(
      <ZoomableImage src="data:image/png;base64,AA==" name="image" onError={vi.fn()} ref={ref} />,
      {
        createNodeMock: (element) =>
          (element.props as { role?: string }).role === "region" ? viewport : null,
      },
    );
  });
  const region = renderer!.root.findByProps({ role: "region" });
  await act(() => {
    region.props.onKeyDown({
      key: "Enter",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      repeat: false,
      preventDefault: vi.fn(),
    });
  });
  expect(ref.current?.pan("ArrowRight")).toBe(false);
  viewport.offsetWidth = 400;
  viewport.clientWidth = 385;
  viewport.scrollWidth = 390;
  const left = viewport.scrollLeft;
  const top = viewport.scrollTop;
  expect(ref.current?.pan("ArrowRight")).toBe(true);
  expect(viewport.scrollLeft).toBe(left + 40);
  expect(ref.current?.pan("ArrowDown")).toBe(true);
  expect(viewport.scrollTop).toBe(top + 40);
});
