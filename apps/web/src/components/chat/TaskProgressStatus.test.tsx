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
    expect(markup).toContain("bg-status-active");
    expect(markup).toContain("bg-muted-foreground/25");
    expect(markup).not.toContain("<circle");
  });

  it("uses a 12 px Dot Matrix for expanded task rows", () => {
    const completed = renderToStaticMarkup(<TaskStatusIndicator status="completed" />);
    const active = renderToStaticMarkup(<TaskStatusIndicator status="inProgress" />);

    expect(completed).toContain('data-slot="dot-matrix"');
    expect(completed).toContain('data-state="success"');
    const rootClassTokens = /class="([^"]+)"/.exec(completed)?.[1]?.split(" ");
    expect(rootClassTokens).toContain("size-[max(12px,0.85em)]");
    expect(completed).toContain('data-size-role="compact"');
    expect(completed.match(/<circle/g)).toHaveLength(25);
    expect(active).toContain('data-state="loading"');
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

    expect(userWait).toContain('data-state="warning"');
    expect(delegateWait).toContain('data-state="waiting"');
    expect(segments).toContain("bg-warning");
    expect(segments).toContain("bg-muted-foreground/50");
  });
});
