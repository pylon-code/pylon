import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Pressable, View } from "react-native";
import { describe, expect, it, vi } from "vite-plus/test";

import { RenderErrorBoundary } from "./RenderErrorBoundary";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("./AppText", () => ({ AppText: "Text" }));
vi.mock("../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));

// React 19's test renderer requires an explicit act environment for updates.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("RenderErrorBoundary", () => {
  it("contains a failed child and retries without remounting its sibling", async () => {
    let throwOnRender = true;
    let siblingMounts = 0;
    function Feed() {
      if (throwOnRender) throw new Error("feed failed");
      return <View>feed ready</View>;
    }
    function Composer() {
      useEffect(() => {
        siblingMounts += 1;
      }, []);
      return <View>draft retained</View>;
    }
    let renderer: ReactTestRenderer | undefined;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        renderer = create(
          <>
            <RenderErrorBoundary
              renderFallback={({ retry }) => <Pressable onPress={retry}>Try again</Pressable>}
            >
              <Feed />
            </RenderErrorBoundary>
            <Composer />
          </>,
        );
      });
      expect(renderer?.root.findAllByType(Pressable)).toHaveLength(1);
      expect(renderer?.root.findAllByType(View)).toHaveLength(1);
      throwOnRender = false;
      await act(async () => {
        renderer?.root.findByType(Pressable).props.onPress();
      });
      expect(renderer?.root.findAllByType(Pressable)).toHaveLength(0);
      expect(renderer?.root.findAllByType(View)).toHaveLength(2);
      expect(siblingMounts).toBe(1);
    } finally {
      errorLog.mockRestore();
      await act(async () => renderer?.unmount());
    }
  });

  it("clears the failure when route identity changes", async () => {
    let throwOnRender = true;
    function Screen() {
      if (throwOnRender) throw new Error("route failed");
      return <View>route ready</View>;
    }
    const render = (route: string) => (
      <RenderErrorBoundary
        resetKeys={[route]}
        renderFallback={() => <Pressable>Unavailable</Pressable>}
      >
        <Screen />
      </RenderErrorBoundary>
    );
    let renderer: ReactTestRenderer | undefined;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        renderer = create(render("thread-a"));
      });
      expect(renderer?.root.findAllByType(Pressable)).toHaveLength(1);
      throwOnRender = false;
      await act(async () => renderer?.update(render("thread-a")));
      expect(renderer?.root.findAllByType(Pressable)).toHaveLength(1);
      await act(async () => renderer?.update(render("thread-b")));
      expect(renderer?.root.findAllByType(View)).toHaveLength(1);
    } finally {
      errorLog.mockRestore();
      await act(async () => renderer?.unmount());
    }
  });
});
