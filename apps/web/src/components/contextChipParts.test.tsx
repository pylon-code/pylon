import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComposerContextScope, ContextChipPopover, PullRequestChip } from "./contextChipParts";

vi.mock("~/lib/openPullRequestLink", () => ({ usePullRequestPreviewTarget: () => null }));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: ({ children }: { children: ReactNode }) => children,
}));

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

describe("pull request context chip", () => {
  it.each([
    { state: "open", isDraft: false, label: "Open", icon: "lucide-git-pull-request-arrow" },
    { state: "open", isDraft: true, label: "Draft", icon: "lucide-git-pull-request-draft" },
    { state: "closed", isDraft: true, label: "Closed", icon: "lucide-git-pull-request-closed" },
    { state: "merged", isDraft: true, label: "Merged", icon: "lucide-git-merge" },
  ] as const)(
    "shows $label state in icon and accessible name",
    ({ state, isDraft, label, icon }) => {
      const markup = renderToStaticMarkup(
        <PullRequestChip
          metadata={{
            number: 42,
            title: "Fix search",
            url: "https://example.com/pull/42",
            headBranch: "feature",
            baseBranch: "main",
            state,
            isDraft,
          }}
          environmentId={null}
          label="#42"
          kindLabel="Pull request"
          className=""
          labelClassName=""
          onOpen={() => undefined}
        />,
      );
      expect(markup).toContain(`(${label})`);
      expect(markup).toContain(icon);
    },
  );
});
