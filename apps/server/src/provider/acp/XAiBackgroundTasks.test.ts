import { describe, expect, it } from "vite-plus/test";
import { TurnId } from "@t3tools/contracts";

import {
  buildGrokBackgroundTaskEvents,
  type GrokBackgroundTaskRecord,
} from "./XAiBackgroundTasks.ts";

const turnId = TurnId.make("turn-1");
const monitor = { type: "Monitor", taskId: "monitor-1", timeoutMs: 60_000 };
const shell = { type: "BackgroundTaskStarted", task_id: "shell-1", command: "sleep 40" };

function mapper() {
  const tasks = new Map<string, GrokBackgroundTaskRecord>();
  const completedTaskIds = new Map<string, string | undefined>();
  const ambiguousTaskIds = new Set<string>();
  const update = (
    rawOutput: unknown,
    overrides: Partial<Parameters<typeof buildGrokBackgroundTaskEvents>[0]> = {},
  ) =>
    buildGrokBackgroundTaskEvents({
      tasks,
      completedTaskIds,
      ambiguousTaskIds,
      toolCallId: "call-1",
      rawInput: { description: "Watch" },
      rawOutput,
      toolCallStatus: "completed",
      turnId,
      ...overrides,
    });
  return { tasks, completedTaskIds, ambiguousTaskIds, update };
}

describe("Grok background tasks", () => {
  it.each([
    [monitor, "monitor-1", "monitor", "Watch"],
    [shell, "shell-1", "shell", "sleep 40"],
  ] as const)("starts and deduplicates %j", (output, id, taskType, description) => {
    const { tasks, update } = mapper();
    expect(update(output)).toEqual([
      {
        type: "task.started",
        turnId,
        payload: { taskId: id, taskType, description, title: description, toolUseId: "call-1" },
      },
    ]);
    expect(update(output)).toEqual([]);
    expect(tasks.size).toBe(1);
  });

  it("accepts automatic backgrounding before the tool becomes terminal", () => {
    const { update } = mapper();
    expect(update(shell, { toolCallStatus: "inProgress" })[0]?.type).toBe("task.started");
    expect(update(monitor, { toolCallStatus: "inProgress" })).toEqual([]);
    expect(update(monitor, { toolCallStatus: "failed" })).toEqual([]);
  });

  it.each([
    ["running", null, "task.progress", undefined],
    ["pending", null, "task.progress", undefined],
    ["completed", 0, "task.completed", "completed"],
    ["success", 0, "task.completed", "completed"],
    ["succeeded", 0, "task.completed", "completed"],
    ["failed", 1, "task.completed", "failed"],
    ["error", 1, "task.completed", "failed"],
    ["stopped", 137, "task.completed", "stopped"],
    ["killed", 137, "task.completed", "stopped"],
    ["cancelled", 137, "task.completed", "stopped"],
    [undefined, 0, "task.completed", "completed"],
    [undefined, 1, "task.completed", "failed"],
  ])("maps poll status %s / exit %s", (status, exit_code, type, expectedStatus) => {
    const { tasks, update } = mapper();
    update(monitor);
    const events = update({
      type: "TaskOutput",
      Result: {
        task_id: "monitor-1",
        command: "[monitor:Watch]",
        status,
        exit_code,
        output: "\n result\nmore",
      },
    });
    expect(events).toEqual([
      {
        type,
        turnId,
        payload: {
          taskId: "monitor-1",
          taskType: "monitor",
          description: "Watch",
          title: "Watch",
          toolUseId: "call-1",
          summary: "result",
          ...(expectedStatus ? { status: expectedStatus } : {}),
        },
      },
    ]);
    expect(tasks.size).toBe(type === "task.progress" ? 1 : 0);
  });

  it.each([undefined, TurnId.make("turn-2")])(
    "does not attribute old tasks to a later turn: %s",
    (laterTurnId) => {
      const { tasks, update } = mapper();
      update(shell);
      const events = update(
        {
          type: "TaskOutput",
          Result: { task_id: "shell-1", command: "sleep 40", status: "completed" },
        },
        { turnId: laterTurnId },
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.turnId).toBeUndefined();
      expect(tasks.size).toBe(0);
    },
  );

  it("starts unknown poll tasks before progress or completion and ignores subagents", () => {
    const { tasks, update } = mapper();
    const events = update({
      type: "TaskOutput",
      MultiResult: {
        results: [
          { task_id: "shell-1", command: "sleep 40", status: "running" },
          { task_id: "monitor-1", command: "[monitor] Watch", status: "completed" },
          { task_id: "agent-1", command: "[subagent:executor] work", status: "running" },
        ],
      },
    });
    expect(events.map(({ type }) => type)).toEqual([
      "task.started",
      "task.progress",
      "task.started",
      "task.completed",
    ]);
    expect(events.map(({ payload }) => payload.taskType)).toEqual([
      "shell",
      "shell",
      "monitor",
      "monitor",
    ]);
    expect([...tasks.keys()]).toEqual(["shell-1"]);
    expect(events.map((event) => event.turnId)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("retires only successfully killed tasks, including mixed results", () => {
    const { tasks, update } = mapper();
    update(shell);
    update(monitor);
    const result = { type: "KillTask", Result: { task_id: "shell-1", outcome: "killed" } };
    expect(update(result, { toolCallStatus: "failed" })).toEqual([]);
    expect(tasks.size).toBe(2);
    const events = update({
      type: "KillTask",
      MultiResult: {
        results: [
          result.Result,
          { task_id: "monitor-1", outcome: "error" },
          { task_id: "unknown", outcome: "killed" },
        ],
      },
    });
    expect(events).toEqual([
      {
        type: "task.completed",
        turnId,
        payload: {
          taskId: "shell-1",
          taskType: "shell",
          description: "sleep 40",
          title: "sleep 40",
          toolUseId: "call-1",
          status: "stopped",
        },
      },
    ]);
    expect([...tasks.keys()]).toEqual(["monitor-1"]);
  });

  it("ignores repeated terminal polls and gives a reused provider id a new runtime identity", () => {
    const { tasks, completedTaskIds, update } = mapper();
    update(shell);
    const terminal = {
      type: "TaskOutput",
      Result: { task_id: "shell-1", command: "sleep 40", status: "completed" },
    };
    expect(update(terminal).map((event) => event.type)).toEqual(["task.completed"]);
    expect(update(terminal)).toEqual([]);
    expect(completedTaskIds.get("shell-1")).toBe("call-1");
    expect(update(shell, { toolCallId: "call-2", turnId: TurnId.make("turn-2") })).toMatchObject([
      { type: "task.started", payload: { taskId: "shell-1#call-2", toolUseId: "call-2" } },
    ]);
    expect(tasks.get("shell-1")?.payload.taskId).toBe("shell-1#call-2");
  });

  it("remembers terminal identities for the session even after many other completions", () => {
    const { completedTaskIds, update } = mapper();
    const completed = (id: string) => ({
      type: "TaskOutput",
      Result: { task_id: id, command: "echo done", status: "completed" },
    });
    update(completed("old-task"));
    for (let index = 0; index < 513; index += 1) {
      update(completed(`task-${index}`));
    }
    expect(completedTaskIds.size).toBe(514);
    expect(update(completed("old-task"))).toEqual([]);
  });

  it("fails closed when two live tool calls claim the same provider task id", () => {
    const { tasks, ambiguousTaskIds, update } = mapper();
    update(shell);
    expect(update(shell, { toolCallId: "call-2" })).toMatchObject([
      { type: "task.completed", payload: { taskId: "shell-1", status: "stopped" } },
    ]);
    expect(ambiguousTaskIds.has("shell-1")).toBe(true);
    expect(tasks.has("shell-1")).toBe(false);
    expect(
      update({
        type: "TaskOutput",
        Result: { task_id: "shell-1", command: "sleep 40", status: "completed" },
      }),
    ).toEqual([]);
  });

  it("bounds long descriptions and output lines before projecting them", () => {
    const { update } = mapper();
    const [started] = update(monitor, {
      rawInput: { description: "a".repeat(2_000) },
    });
    expect(started?.type).toBe("task.started");
    if (started?.type !== "task.started") throw new Error("expected task.started");
    expect(started?.payload.description).toHaveLength(200);
    const [progress] = update({
      type: "TaskOutput",
      Result: {
        task_id: "monitor-1",
        command: "[monitor] Watch",
        status: "running",
        output: "b".repeat(2_000),
      },
    });
    expect(progress?.type).toBe("task.progress");
    if (progress?.type !== "task.progress") throw new Error("expected task.progress");
    expect(progress?.payload.summary).toHaveLength(512);
  });

  it.each([
    null,
    [],
    {},
    { type: "Text", text: "subagent_id: fake\ntype: executor\ndescription: fake" },
    { type: "Monitor", taskId: " " },
    { type: "BackgroundTaskStarted", task_id: "shell-1" },
    {
      type: "TaskOutput",
      MultiResult: {
        results: [null, {}, { task_id: "task", command: "sleep 40", exit_code: Infinity }],
      },
    },
  ])("ignores malformed or unrelated outputs: %j", (output) => {
    const { tasks, update } = mapper();
    expect(update(output)).toEqual([]);
    expect(tasks.size).toBe(0);
  });
});
