import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  areComposerTasksDismissed,
  composerTasksWaitingKey,
  ComposerTasksBadge,
  ComposerTasksDrawer,
} from "./ComposerTasksBadge";

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
    expect(markup).toContain("left-5.5");
    expect(markup).toContain("right-5.5");
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
    expect(markup).toContain("bg-primary");
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

    expect(markup).toContain("right-30");
    expect(markup).not.toContain("right-5.5");
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
    expect(markup).toContain("ml-auto shrink-0");
    expect(markup).toContain("4.0s");
    expect(markup).toContain("now");
    expect(markup).toContain("Attach task progress");
    expect(markup).toContain("Verify the result");
    expect(markup).toContain("lucide-list-todo");
    expect(markup).toContain('aria-label="Dismiss tasks for this turn"');
    expect(markup).toContain('data-chat-composer-collapsed-controls="true"');
    expect(markup).toContain('aria-label="Collapse tasks. 1 of 3 complete."');
    expect(markup).toContain('aria-label="Task list. 1 of 3 complete."');
    expect(markup).toContain('data-composer-tasks-list="true"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("max-h-[min(24rem,40dvh)]");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("overscroll-contain");
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain("focus-visible:ring-inset");
    expect(markup).toContain("lucide-chevron-down");
    expect(markup).not.toContain('data-task-progress-segments="true"');
    expect(markup).toContain("✓");
    expect(markup).toContain("●");
    expect(markup).toContain("○");
    expect(markup).toContain("text-success");
    expect(markup).toContain("text-primary");
    expect(markup).toContain("text-muted-foreground/40");
    expect(markup).not.toContain('data-slot="dot-matrix"');
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

  it("renders one compact delegated-work aggregate beside an honest wait", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksBadge
        delegatedWork={{ workingAgents: 2, waitingAgents: 1 }}
        expanded={false}
        onDismiss={() => undefined}
        onToggle={() => undefined}
        placement="inline"
        progress={{ step: "Await delegated review", completedSteps: 1, totalSteps: 3 }}
        steps={[
          { step: "Implement", status: "completed" },
          { step: "Await delegated review", status: "waiting", waitingOn: "delegates" },
          { step: "Ship", status: "pending" },
        ]}
      />,
    );

    expect(markup).toContain("2 agents working, 1 waiting");
    expect(markup).toContain("Waiting on agents");
    expect(markup).toContain("bg-muted-foreground/50");
    expect(markup).not.toContain("bg-warning");
  });

  it.each(["user", "delegates", "external"] as const)(
    "names %s as the wait owner in the task drawer",
    (waitingOn) => {
      const markup = renderToStaticMarkup(
        <ComposerTasksDrawer
          onDismiss={() => undefined}
          onCollapse={() => undefined}
          progress={{ step: "Await dependency", completedSteps: 0, totalSteps: 1 }}
          steps={[{ step: "Await dependency", status: "waiting", waitingOn }]}
        />,
      );

      const label =
        waitingOn === "user"
          ? "Needs your input"
          : waitingOn === "delegates"
            ? "Waiting on agents"
            : "Waiting on external system";
      expect(markup).toContain(label);
      if (waitingOn === "user") {
        expect(markup).toContain("●");
        expect(markup).toContain("text-warning");
      } else {
        expect(markup).toContain("○");
        expect(markup).toContain("text-muted-foreground/50");
        expect(markup).not.toContain("text-warning");
      }
    },
  );

  it("drops the step segments when they would render as a blank gap", () => {
    const manySteps = Array.from({ length: 24 }, (_, index) => ({
      step: `Step ${index + 1}`,
      status: "pending" as const,
    }));
    const tab = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onDismiss={() => undefined}
        onToggle={() => undefined}
        progress={{ ...progress, totalSteps: manySteps.length }}
        steps={manySteps}
      />,
    );
    const inline = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onDismiss={() => undefined}
        onToggle={() => undefined}
        placement="inline"
        progress={{ ...progress, totalSteps: manySteps.length }}
        steps={manySteps}
      />,
    );

    expect(tab).not.toContain("w-20");
    expect(tab).toContain("1/24");
    expect(inline).not.toContain("w-10");
    expect(inline).toContain("1/24");
  });
});

describe("composer task dismissal semantics", () => {
  it("keeps the same state dismissed but resurfaces meaningful wait changes", () => {
    const activeSteps = [{ step: "Implement", status: "inProgress" }] as const;
    const waitForUser = [{ step: "Review", status: "waiting", waitingOn: "user" }] as const;
    const initialDismissal = { turnId: "turn-1", waitingKey: null };

    expect(areComposerTasksDismissed(initialDismissal, "turn-1", activeSteps)).toBe(true);
    expect(areComposerTasksDismissed(initialDismissal, "turn-1", waitForUser)).toBe(false);

    const waitingDismissal = {
      turnId: "turn-1",
      waitingKey: composerTasksWaitingKey(waitForUser),
    };
    expect(areComposerTasksDismissed(waitingDismissal, "turn-1", waitForUser)).toBe(true);
    expect(
      areComposerTasksDismissed(waitingDismissal, "turn-1", [
        { step: "Review", status: "waiting", waitingOn: "external" },
      ]),
    ).toBe(false);
    expect(
      areComposerTasksDismissed(waitingDismissal, "turn-1", [
        { step: "Approve", status: "waiting", waitingOn: "user" },
      ]),
    ).toBe(false);
    expect(areComposerTasksDismissed(waitingDismissal, "turn-2", waitForUser)).toBe(false);
  });
});

describe("delegated work copy", () => {
  it("names agents when every live delegate is waiting", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksBadge
        delegatedWork={{ workingAgents: 0, waitingAgents: 1 }}
        expanded={false}
        onDismiss={() => undefined}
        onToggle={() => undefined}
        progress={{ step: "Implement", completedSteps: 0, totalSteps: 1 }}
        steps={[{ step: "Implement", status: "inProgress" }]}
      />,
    );

    expect(markup).toContain("1 agent waiting");
  });

  it("keeps every long-list task inside the bounded scroll region", () => {
    const longSteps = Array.from({ length: 20 }, (_, index) => ({
      step: `Task ${index + 1}`,
      status: index === 0 ? ("inProgress" as const) : ("pending" as const),
    }));
    const markup = renderToStaticMarkup(
      <ComposerTasksDrawer
        onCollapse={() => undefined}
        onDismiss={() => undefined}
        progress={{ step: "Task 1", completedSteps: 0, totalSteps: longSteps.length }}
        steps={longSteps}
      />,
    );

    const listStart = markup.indexOf('data-composer-tasks-list="true"');
    expect(listStart).toBeGreaterThan(markup.indexOf('aria-label="Collapse tasks.'));
    expect(markup.slice(listStart)).toContain("Task 20");
  });
});
