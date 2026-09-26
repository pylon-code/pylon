import { act } from "react";
import { create } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { BrowserSurfaceSlot } from "./BrowserSurfaceSlot";

const { present, release } = vi.hoisted(() => ({ present: vi.fn(() => true), release: vi.fn() }));
vi.mock("./browserSurfaceStore", () => ({
  acquireBrowserSurface: () => ({ present, release }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("tracks an inline panel moving its browser slot and cleans up the surface lease", async () => {
  let panelResize: (() => void) | undefined;
  const panel = {};
  const slot = {
    closest: (selector: string) =>
      selector === '[data-preview-panel-mode="inline"]' ? panel : null,
    getBoundingClientRect: () => ({ x: position, y: 8, width: 320, height: 240 }),
  };
  let position = 20;
  const observed: unknown[] = [];
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {}
      observe(target: unknown) {
        observed.push(target);
        if (target === panel) panelResize = this.callback;
      }
      disconnect = disconnect;
    },
  );
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  let renderer: ReturnType<typeof create>;
  await act(() => {
    renderer = create(<BrowserSurfaceSlot tabId="tab-1" visible />, {
      createNodeMock: () => slot,
    });
  });
  expect(observed).toEqual([slot, panel]);
  expect(present).toHaveBeenCalledWith({ x: 20, y: 8, width: 320, height: 240 }, true, 0, 30);
  position = 40;
  // The panel observer must remeasure even though the slot's own dimensions did not change.
  await act(() => panelResize?.());
  expect(present).toHaveBeenLastCalledWith({ x: 40, y: 8, width: 320, height: 240 }, true, 0, 30);
  await act(() => renderer!.unmount());
  expect(disconnect).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});
