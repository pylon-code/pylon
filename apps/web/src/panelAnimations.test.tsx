import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { usePanelNavigationSuppression, usePanelPresence } from "./panelAnimations";

let renderer: ReactTestRenderer | null = null;
let pendingFrames: FrameRequestCallback[] = [];
let observed: boolean[] = [];

function SuppressionProbe({ navigationKey }: { navigationKey: string }) {
  const suppressed = usePanelNavigationSuppression(navigationKey);
  useLayoutEffect(() => {
    observed.push(suppressed);
  }, [suppressed]);
  return null;
}

beforeEach(() => {
  pendingFrames = [];
  observed = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    }),
    cancelAnimationFrame: vi.fn(),
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("closing panel ownership", () => {
  let presence: ReturnType<typeof usePanelPresence<string>>;
  function Panel({
    open,
    scope,
    animated = true,
  }: {
    open: boolean;
    scope: string;
    animated?: boolean;
  }) {
    presence = usePanelPresence(open, open ? scope : null, animated, scope, 400);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
  });

  it("retains closing content but never carries it into another thread", async () => {
    await act(() => {
      renderer = create(<Panel open scope="first" />);
    });
    await act(() => {
      renderer?.update(<Panel open={false} scope="first" />);
    });
    expect(presence).toEqual({ present: true, value: "first" });
    await act(() => {
      renderer?.update(<Panel open={false} scope="second" />);
    });
    expect(presence).toEqual({ present: false, value: null });
  });

  it("cancels pending removal when the panel reopens", async () => {
    await act(() => {
      renderer = create(<Panel open scope="first" />);
    });
    await act(() => {
      renderer?.update(<Panel open={false} scope="first" />);
    });
    await act(() => {
      vi.advanceTimersByTime(200);
    });
    await act(() => {
      renderer?.update(<Panel open scope="first" />);
    });
    await act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(presence).toEqual({ present: true, value: "first" });
  });

  it("releases content immediately when motion is suppressed", async () => {
    await act(() => {
      renderer = create(<Panel open scope="first" />);
    });
    await act(() => {
      renderer?.update(<Panel open={false} scope="first" animated={false} />);
    });
    expect(presence).toEqual({ present: false, value: null });
  });
});

async function paintPendingFrame() {
  const callback = pendingFrames.shift();
  await act(() => callback?.(0));
}

describe("usePanelNavigationSuppression", () => {
  it("suppresses initial and navigated panel state until each route has painted", async () => {
    await act(() => {
      renderer = create(<SuppressionProbe navigationKey="/thread/one" />);
    });
    expect(observed.at(-1)).toBe(true);

    await paintPendingFrame();
    expect(observed.at(-1)).toBe(true);
    await paintPendingFrame();
    expect(observed.at(-1)).toBe(false);

    await act(() => {
      renderer?.update(<SuppressionProbe navigationKey="/thread/two" />);
    });
    expect(observed.at(-1)).toBe(true);

    await paintPendingFrame();
    expect(observed.at(-1)).toBe(true);
    await paintPendingFrame();
    expect(observed.at(-1)).toBe(false);
  });
});
