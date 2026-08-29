import { ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  sidebarStatusColorClass,
  statusForegroundColorClass,
  ThreadStatusLabel,
  ThreadWorktreeIndicator,
} from "./ThreadStatusIndicators";

describe("ThreadWorktreeIndicator", () => {
  it("renders the worktree folder and branch in an accessible label", () => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "feature/sidebar-indicator",
          worktreePath: "/tmp/worktrees/sidebar-indicator",
        }}
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      'aria-label="Worktree: sidebar-indicator (feature/sidebar-indicator)"',
    );
    expect(markup).toContain('data-testid="thread-worktree-thread-1"');
  });

  it.each([null, "", "   "])("renders nothing for an absent worktree path", (worktreePath) => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "main",
          worktreePath,
        }}
      />,
    );

    expect(markup).toBe("");
  });
});

describe("ThreadStatusLabel", () => {
  it("maps aggregate active and info status colors onto sidebar roles", () => {
    expect(sidebarStatusColorClass("text-status-active")).toBe("text-status-active-sidebar");
    expect(sidebarStatusColorClass("text-status-info")).toBe("text-status-info-sidebar");
    expect(sidebarStatusColorClass("text-warning")).toBe("text-warning");
    expect(statusForegroundColorClass("text-status-active")).toBe("text-status-active-foreground");
    expect(statusForegroundColorClass("text-status-active-sidebar")).toBe(
      "text-status-active-foreground-sidebar",
    );
  });

  const status = {
    label: "Working",
    colorClass: "text-status-active",
    matrix: "loading" as const,
  };

  it("uses separate readable label and indicator roles on the sidebar", () => {
    const markup = renderToStaticMarkup(<ThreadStatusLabel status={status} surface="sidebar" />);

    expect(markup).toContain("text-status-active-sidebar");
    expect(markup).toContain("text-status-active-foreground-sidebar");
    expect(markup).not.toMatch(/(?:^|\s)text-status-active(?:\s|$)/);
  });

  it("uses separate readable label and indicator roles on the canvas", () => {
    const markup = renderToStaticMarkup(<ThreadStatusLabel status={status} />);

    expect(markup).toMatch(/(?:^|\s)text-status-active(?:\s|$)/);
    expect(markup).toContain("text-status-active-foreground");
    expect(markup).not.toContain("text-status-active-sidebar");
  });
});
