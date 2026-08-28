import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerTasksBadge, ComposerTasksDrawer } from "./ComposerTasksBadge";

const progress = {
  step: "Attach task progress",
  completedSteps: 1,
  totalSteps: 3,
};
const steps = [
  { durationMs: 4_000, step: "Inspect the composer", status: "completed" as const },
  { step: "Attach task progress", status: "inProgress" as const },
  { step: "Verify the result", status: "pending" as const },
];

describe("ComposerTasksBadge", () => {
  it("renders active progress as an attached composer tab", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onDismiss={() => undefined}
        onToggle={() => undefined}
        progress={progress}
        steps={steps}
      />,
    );

    expect(markup).toContain('data-composer-tasks-badge="true"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("chat-composer-shoulder-tab");
    expect(markup).toContain("chat-composer-tasks-tab");
    expect(markup).toContain("rounded-t-xl");
    expect(markup).toContain("border-b-0");
    expect(markup).toContain("left-4");
    expect(markup).toContain("right-4");
    expect(markup).toContain('data-composer-task-current="true"');
    expect(markup).toContain("min-w-0 flex-1 truncate");
    expect(markup).toContain("w-20");
    expect(markup).toContain("Tasks");
    expect(markup).toContain("Attach task progress");
    expect(markup).not.toContain("·");
    expect(markup).toContain("1/3");
    expect(markup).toContain("Current task: Attach task progress");
    expect(markup).toContain("lucide-list-todo");
    expect(markup).toContain('aria-label="Dismiss tasks for this turn"');
    expect(markup).toContain("lucide-x");
    expect(markup).not.toContain("lucide-chevron");
    expect(markup).toContain('data-task-progress-segments="true"');
    expect(markup).toContain('data-task-status="completed"');
    expect(markup).toContain('data-task-status="inProgress"');
    expect(markup).toContain('data-task-status="pending"');
    expect(markup).toContain("bg-success");
    expect(markup).toContain("bg-status-active");
    expect(markup).toContain("bg-muted-foreground/25");
  });

  it("leaves room for the stash tab when both shoulders are present", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        hasTrailingShoulder
        onDismiss={() => undefined}
        onToggle={() => undefined}
        progress={progress}
        steps={steps}
      />,
    );

    expect(markup).toContain("right-28");
    expect(markup).not.toContain("right-4");
  });

  it("has a compact inline fallback for occupied composer shoulders", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onDismiss={() => undefined}
        onToggle={() => undefined}
        placement="inline"
        progress={progress}
        steps={steps}
      />,
    );

    expect(markup).toContain("rounded-sm");
    expect(markup).toContain("1/3");
    expect(markup).not.toContain("chat-composer-shoulder-tab");
    expect(markup).not.toContain("rounded-t-xl");
    expect(markup).toContain("w-10");
  });

  it("expands into a read-only attached task list", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksDrawer
        onCollapse={() => undefined}
        onDismiss={() => undefined}
        progress={progress}
        steps={steps}
      />,
    );

    expect(markup).toContain('data-chat-composer-tasks-drawer="true"');
    expect(markup).not.toContain("data-variant");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('role="list"');
    expect(markup).toContain("Inspect the composer");
    expect(markup).toContain('data-composer-task-duration="true"');
    expect(markup).toContain("ml-auto w-10");
    expect(markup).toContain("4.0s");
    expect(markup).toContain("now");
    expect(markup).toContain("Attach task progress");
    expect(markup).toContain("Verify the result");
    expect(markup).toContain("lucide-list-todo");
    expect(markup).toContain('aria-label="Dismiss tasks for this turn"');
    expect(markup).not.toContain("lucide-chevron");
    expect(markup).not.toContain('data-task-progress-segments="true"');
    expect(markup).toContain('data-state="success"');
    expect(markup).toContain('data-state="loading"');
    expect(markup).toContain('data-state="idle"');
    expect(markup.match(/<circle/g)).toHaveLength(75);
    expect(markup).toContain('data-slot="dot-matrix"');
    expect(markup).toContain('data-size-role="compact"');
    expect(markup).toContain("size-[max(12px,0.85em)]");
    expect(markup).toContain("Completed:");
    expect(markup).toContain("In progress:");
    expect(markup).toContain("Pending:");
  });

  it("does not render an empty task count", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onDismiss={() => undefined}
        onToggle={() => undefined}
        progress={{ ...progress, totalSteps: 0 }}
        steps={steps}
      />,
    );

    expect(markup).toBe("");
  });
});
