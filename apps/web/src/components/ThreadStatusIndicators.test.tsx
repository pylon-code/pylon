import { ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  terminalStatusFromRunningIds,
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
  const status = {
    label: "Working",
    colorClass: "text-sky-600 dark:text-sky-300/80",
    dotClass: "bg-sky-500 dark:bg-sky-300/80",
    pulse: true,
  };

  it("renders the upstream hue and reduced-motion-safe pulse", () => {
    const markup = renderToStaticMarkup(<ThreadStatusLabel status={status} />);

    expect(markup).toContain("text-sky-600");
    expect(markup).toContain("bg-sky-500");
    expect(markup).toContain("animate-status-pulse");
    expect(markup).toContain("motion-reduce:animate-none");
    expect(markup).not.toContain('data-slot="dot-matrix"');
  });

  it("keeps compact static statuses static", () => {
    const markup = renderToStaticMarkup(
      <ThreadStatusLabel status={{ ...status, label: "Monitoring", pulse: false }} compact />,
    );

    expect(markup).toContain("size-[9px]");
    expect(markup).not.toContain("animate-status-pulse");
  });

  it("restores the upstream teal terminal signal", () => {
    expect(terminalStatusFromRunningIds(["terminal-1"])).toEqual({
      label: "Terminal process running",
      colorClass: "text-teal-600 dark:text-teal-300/90",
      pulse: true,
    });
    expect(terminalStatusFromRunningIds([])).toBeNull();
  });
});
