import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  keyedTaskProgressSteps,
  TaskProgressSegments,
  TaskStatusIndicator,
} from "./TaskProgressStatus";

describe("TaskProgressStatus", () => {
  it("uses occurrence keys when task descriptions repeat", () => {
    expect(
      keyedTaskProgressSteps([
        { step: "Repeat", status: "completed" },
        { step: "Repeat", status: "inProgress" },
        { step: "Repeat", status: "pending" },
      ]).map(({ key }) => key),
    ).toEqual(["Repeat:0", "Repeat:1", "Repeat:2"]);
  });

  it("hides the collapsed progress bar for a one-step plan", () => {
    const markup = renderToStaticMarkup(
      <TaskProgressSegments steps={[{ step: "Only task", status: "inProgress" }]} />,
    );

    expect(markup).toBe("");
  });

  it("renders the original solid segments in collapsed progress", () => {
    const markup = renderToStaticMarkup(
      <TaskProgressSegments
        steps={[
          { step: "Done", status: "completed" },
          { step: "Active", status: "inProgress" },
          { step: "Next", status: "pending" },
        ]}
      />,
    );

    expect(markup).toContain('data-task-progress-segments="true"');
    expect(markup).toContain("rounded-full");
    expect(markup).toContain("bg-success");
    expect(markup).toContain("bg-primary");
    expect(markup).toContain("bg-muted-foreground/25");
    expect(markup).not.toContain("<circle");
  });

  it("renders upstream task glyphs for expanded rows", () => {
    const completed = renderToStaticMarkup(<TaskStatusIndicator status="completed" />);
    const active = renderToStaticMarkup(<TaskStatusIndicator status="inProgress" />);
    const pending = renderToStaticMarkup(<TaskStatusIndicator status="pending" />);

    expect(completed).toContain("✓");
    expect(completed).toContain("text-success");
    expect(active).toContain("●");
    expect(active).toContain("text-primary");
    expect(pending).toContain("○");
    expect(pending).toContain("text-muted-foreground/40");
    expect(completed).not.toContain('data-slot="dot-matrix"');
  });

  it("distinguishes user-owned waits from passive waits", () => {
    const userWait = renderToStaticMarkup(
      <TaskStatusIndicator status="waiting" waitingOn="user" />,
    );
    const delegateWait = renderToStaticMarkup(
      <TaskStatusIndicator status="waiting" waitingOn="delegates" />,
    );
    const segments = renderToStaticMarkup(
      <TaskProgressSegments
        steps={[
          { step: "Review", status: "waiting", waitingOn: "user" },
          { step: "Delegate", status: "waiting", waitingOn: "delegates" },
        ]}
      />,
    );

    expect(userWait).toContain("●");
    expect(userWait).toContain("text-warning");
    expect(delegateWait).toContain("○");
    expect(delegateWait).toContain("text-muted-foreground/50");
    expect(segments).toContain("bg-warning");
    expect(segments).toContain("bg-muted-foreground/50");
  });
});
