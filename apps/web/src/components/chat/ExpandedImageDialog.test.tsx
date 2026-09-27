import { act, type KeyboardEventHandler, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ExpandedImageDialog } from "./ExpandedImageDialog";

const state = vi.hoisted(() => ({
  contextMenuOpen: false,
  change: undefined as
    | undefined
    | ((open: boolean, details: { reason: string; cancel: () => void }) => void),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange: typeof state.change;
  }) => {
    state.change = onOpenChange;
    return children;
  },
  DialogPopup: ({
    children,
    onKeyDown,
  }: {
    children: ReactNode;
    onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  }) => (
    <div data-test-dialog-popup onKeyDown={onKeyDown}>
      {children}
    </div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../media/MediaActions", () => ({
  MediaActions: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ZoomableImage", () => ({ ZoomableImage: () => <img alt="preview" /> }));
vi.mock("../../contextMenuFallback", () => ({ isContextMenuOpen: () => state.contextMenuOpen }));
vi.mock("../../assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: () => ({ _tag: "Pending" }),
}));
vi.mock("../../state/session", () => ({ usePreparedConnection: () => ({ _tag: "None" }) }));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(() => renderer?.unmount());
  renderer = undefined;
  state.contextMenuOpen = false;
  vi.unstubAllGlobals();
});
describe("expanded media dismissal", () => {
  it("leaves nested Escape dismissal to the dialog stack and preserves fallback context menus", async () => {
    const listeners: Array<(event: KeyboardEvent) => void> = [];
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "HTMLElement",
      class {
        isConnected = false;
      },
    );
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("window", {
      addEventListener: (_name: string, listener: (event: KeyboardEvent) => void) =>
        listeners.push(listener),
      removeEventListener: vi.fn(),
    });
    const close = vi.fn();
    await act(() => {
      renderer = create(
        <ExpandedImageDialog
          preview={{ images: [{ src: "data:image/png;base64,AA==", name: "image.png" }], index: 0 }}
          onClose={close}
        />,
      );
    });
    const escape = new Event("keydown", { cancelable: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    for (const listener of listeners) listener(escape as KeyboardEvent);
    // The nested primitive owns this event. No global capture handler may close its parent.
    expect(close).not.toHaveBeenCalled();
    expect(escape.defaultPrevented).toBe(false);
    const cancel = vi.fn();
    state.contextMenuOpen = true;
    state.change?.(false, { reason: "escape-key", cancel });
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    state.contextMenuOpen = false;
    state.change?.(false, { reason: "escape-key", cancel });
    expect(close).toHaveBeenCalledOnce();
  });

  it("navigates gallery arrows inside the dialog and leaves video and snapshot keys alone", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "HTMLElement",
      class HTMLElement {
        tagName = "PRE";
      },
    );
    vi.stubGlobal("HTMLVideoElement", function HTMLVideoElement() {});
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const close = vi.fn();
    await act(() => {
      renderer = create(
        <ExpandedImageDialog
          preview={{
            images: [
              { src: "data:image/png;base64,AA==", name: "one.png" },
              { src: "data:image/png;base64,BB==", name: "two.png" },
            ],
            index: 0,
          }}
          onClose={close}
        />,
      );
    });
    const dialog = renderer!.root.find((node) => node.props["data-test-dialog-popup"] === true);
    const press = async (key: string, target: object) => {
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      await act(() => {
        dialog.props.onKeyDown({
          key,
          target,
          defaultPrevented: false,
          preventDefault,
          stopPropagation,
        });
      });
      return { preventDefault, stopPropagation };
    };
    const videoKey = await press("ArrowRight", new HTMLVideoElement());
    expect(videoKey.preventDefault).not.toHaveBeenCalled();
    expect(
      renderer!.root.findAll((node) => node.type === "img" && node.props.alt === "preview"),
    ).toHaveLength(1);

    const snapshotKey = await press("ArrowRight", new HTMLElement());
    expect(snapshotKey.preventDefault).not.toHaveBeenCalled();
    expect(
      renderer!.root.findAll(
        (node) => node.type === "span" && node.children.join("").includes("one.png"),
      ),
    ).not.toHaveLength(0);

    const next = await press("ArrowRight", {});
    expect(next.preventDefault).toHaveBeenCalledOnce();
    expect(next.stopPropagation).toHaveBeenCalledOnce();
    expect(
      renderer!.root.findAll(
        (node) => node.type === "button" && node.props["aria-label"] === "Previous media",
      ),
    ).toHaveLength(1);
    expect(
      renderer!.root.findAll(
        (node) => node.type === "span" && node.children.join("").includes("two.png"),
      ),
    ).not.toHaveLength(0);
    expect(close).not.toHaveBeenCalled();
  });
});
