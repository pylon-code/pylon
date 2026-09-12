import { act, type ReactNode } from "react";
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
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
});
