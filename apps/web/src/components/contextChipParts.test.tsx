import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComposerContextScope, ContextChipPopover } from "./contextChipParts";

vi.mock("./ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
  PopoverTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  PopoverPopup: ({ children, ...props }: { children: ReactNode }) => (
    <aside {...props}>{children}</aside>
  ),
}));

describe("context detail popup ownership", () => {
  it.each([true, false])(
    "preserves composer focus/drop scope only for composer-owned chips (%s)",
    (composerOwned) => {
      const markup = renderToStaticMarkup(
        <ComposerContextScope value={composerOwned}>
          <ContextChipPopover accessibleLabel="Review" chip="Review">
            <button>Inspect captured context</button>
          </ContextChipPopover>
        </ComposerContextScope>,
      );
      expect(markup.includes('data-chat-composer-floating-layer="true"')).toBe(composerOwned);
    },
  );
});
