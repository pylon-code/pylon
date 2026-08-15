import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities missing final response", () => {
  it.each([
    {
      type: "runtime.warning" as const,
      provider: ProviderDriverKind.make("primeAgent"),
      outcome: "completed" as const,
      message: "Prime Agent finished without sending a final response.",
      tone: "info" as const,
    },
    {
      type: "runtime.error" as const,
      provider: ProviderDriverKind.make("primeAgent"),
      outcome: "failed" as const,
      message: "Prime Agent stopped before sending a final response.",
      tone: "error" as const,
    },
  ])("projects the $outcome marker without provider detail", (fixture) => {
    const [activity] = runtimeEventToActivities({
      ...base,
      provider: fixture.provider,
      type: fixture.type,
      eventId: EventId.make(`missing-response-${fixture.outcome}`),
      turnId: TurnId.make(`turn-${fixture.outcome}`),
      payload: {
        message: fixture.message,
        detail: { kind: "missing-final-response", outcome: fixture.outcome },
      },
    } satisfies ProviderRuntimeEvent);

    expect(activity).toMatchObject({
      kind: "turn.response.missing",
      summary: fixture.message,
      tone: fixture.tone,
      payload: { outcome: fixture.outcome },
      turnId: `turn-${fixture.outcome}`,
    });
    expect(activity?.payload).toEqual({ outcome: fixture.outcome });
    expect(JSON.stringify(activity)).not.toContain("missing-final-response");
  });

  it.each([
    {
      name: "an extra field",
      type: "runtime.warning" as const,
      outcome: "completed" as const,
      detail: { kind: "missing-final-response", outcome: "completed", private: "raw" },
    },
    {
      name: "a mismatched outcome",
      type: "runtime.warning" as const,
      outcome: "failed" as const,
      detail: { kind: "missing-final-response", outcome: "failed" },
    },
    {
      name: "a non-object detail",
      type: "runtime.error" as const,
      outcome: "failed" as const,
      detail: "missing-final-response",
    },
  ])("leaves $type unchanged when its marker has $name", (fixture) => {
    const [activity] = runtimeEventToActivities({
      ...base,
      type: fixture.type,
      eventId: EventId.make(`malformed-${fixture.outcome}`),
      payload: {
        message: "Ordinary provider event",
        detail: fixture.detail,
      },
    } satisfies ProviderRuntimeEvent);

    expect(activity?.kind).toBe(fixture.type);
  });

  it("does not reclassify another provider using the same detail shape", () => {
    const [activity] = runtimeEventToActivities({
      ...base,
      type: "runtime.error",
      eventId: EventId.make("other-provider-missing-marker"),
      payload: {
        message: "Codex provider error",
        detail: { kind: "missing-final-response", outcome: "failed" },
      },
    } satisfies ProviderRuntimeEvent);

    expect(activity).toMatchObject({
      kind: "runtime.error",
      summary: "Runtime error",
      payload: { message: "Codex provider error" },
    });
  });

  it("preserves ordinary warning and error activity presentations", () => {
    const [warning] = runtimeEventToActivities({
      ...base,
      type: "runtime.warning",
      eventId: EventId.make("ordinary-warning"),
      payload: { message: "Reconnecting", detail: { willRetry: true } },
    } satisfies ProviderRuntimeEvent);
    const [error] = runtimeEventToActivities({
      ...base,
      type: "runtime.error",
      eventId: EventId.make("ordinary-error"),
      payload: { message: "Provider failed", detail: { private: "unchanged-drop" } },
    } satisfies ProviderRuntimeEvent);

    expect(warning).toMatchObject({
      kind: "runtime.warning",
      summary: "Reconnecting",
      payload: { message: "Reconnecting", detail: { willRetry: true } },
    });
    expect(error).toMatchObject({
      kind: "runtime.error",
      summary: "Runtime error",
      payload: { message: "Provider failed" },
    });
    expect(error?.payload).toEqual({ message: "Provider failed" });
  });
});

describe("runtimeEventToActivities task progress", () => {
  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into their independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload).not.toHaveProperty("status");
  });
});

describe("runtimeEventToActivities context compaction", () => {
  it("replaces start with terminal state and drops every provider detail", () => {
    const itemId = RuntimeItemId.make("compaction:turn-1");
    const turnId = TurnId.make("turn-1");
    const started = {
      ...base,
      type: "item.started",
      eventId: EventId.make("evt-compaction-started"),
      itemId,
      turnId,
      payload: {
        itemType: "context_compaction",
        status: "inProgress",
        title: "PRIVATE TITLE",
        detail: "PRIVATE INSTRUCTIONS",
        data: { summary: "PRIVATE SUMMARY" },
      },
    } satisfies ProviderRuntimeEvent;
    const completed = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-compaction-completed"),
      itemId,
      turnId,
      payload: {
        itemType: "context_compaction",
        status: "completed",
        title: "PRIVATE TITLE",
        detail: "PRIVATE SUMMARY",
        data: { error: "PRIVATE ERROR" },
      },
    } satisfies ProviderRuntimeEvent;

    const [startedActivity] = runtimeEventToActivities(started);
    const [completedActivity] = runtimeEventToActivities(completed);
    expect(startedActivity).toMatchObject({
      id: "context-compaction:codex:thread-1:compaction:turn-1",
      kind: "context-compaction",
      summary: "Compacting context",
      payload: { status: "inProgress" },
    });
    expect(completedActivity).toMatchObject({
      id: startedActivity?.id,
      kind: "context-compaction",
      summary: "Context compacted",
      payload: { status: "completed" },
    });
    expect(JSON.stringify([startedActivity, completedActivity])).not.toContain("PRIVATE");
  });

  it("uses constant failed presentation for aborted or failed completion", () => {
    const [activity] = runtimeEventToActivities({
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-compaction-failed"),
      itemId: RuntimeItemId.make("compaction:turn-1"),
      turnId: TurnId.make("turn-1"),
      payload: {
        itemType: "context_compaction",
        status: "failed",
        detail: "PRIVATE ERROR",
      },
    });

    expect(activity).toMatchObject({
      tone: "error",
      summary: "Context compaction failed",
      payload: { status: "failed" },
    });
    expect(JSON.stringify(activity)).not.toContain("PRIVATE");

    const [skipped] = runtimeEventToActivities({
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-compaction-skipped"),
      itemId: RuntimeItemId.make("compaction:turn-2"),
      turnId: TurnId.make("turn-2"),
      payload: {
        itemType: "context_compaction",
        status: "declined",
        detail: "PRIVATE SKIP EXPLANATION",
      },
    });
    expect(skipped).toMatchObject({
      tone: "info",
      summary: "Context compaction skipped",
      payload: { status: "declined" },
    });
    expect(JSON.stringify(skipped)).not.toContain("PRIVATE");
  });
});

describe("runtimeEventToActivities reported turn cost", () => {
  it("persists finite non-negative values with stable per-turn identity", () => {
    for (const totalCostUsd of [0, 0.0123]) {
      const activities = runtimeEventToActivities({
        ...base,
        type: "turn.completed",
        eventId: EventId.make(`evt-cost-${totalCostUsd}`),
        turnId: TurnId.make("turn-cost"),
        payload: { state: "completed", totalCostUsd },
      });
      expect(activities).toEqual([
        {
          id: "turn-cost:thread-1:turn-cost",
          createdAt: base.createdAt,
          tone: "info",
          kind: "turn.cost",
          summary: "Reported turn cost",
          payload: { totalCostUsd },
          turnId: "turn-cost",
        },
      ]);
    }
  });

  it("drops absent, invalid, negative, and turnless values", () => {
    for (const totalCostUsd of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        runtimeEventToActivities({
          ...base,
          type: "turn.completed",
          eventId: EventId.make("evt-invalid-cost"),
          turnId: TurnId.make("turn-cost"),
          payload: { state: "completed", totalCostUsd },
        }),
      ).toEqual([]);
    }
    expect(
      runtimeEventToActivities({
        ...base,
        type: "turn.completed",
        eventId: EventId.make("evt-turnless-cost"),
        payload: { state: "completed", totalCostUsd: 1 },
      }),
    ).toEqual([]);
  });
});

describe("runtimeEventToActivities retry and refinement lifecycle", () => {
  it("replaces retry lifecycle with constant terminal state", () => {
    const itemId = RuntimeItemId.make("retry:turn-1");
    const start = runtimeEventToActivities({
      ...base,
      type: "item.started",
      eventId: EventId.make("retry-start"),
      turnId: TurnId.make("turn-1"),
      itemId,
      payload: { itemType: "retry", status: "inProgress", detail: "PRIVATE ERROR" },
    })[0];
    const end = runtimeEventToActivities({
      ...base,
      type: "item.completed",
      eventId: EventId.make("retry-end"),
      turnId: TurnId.make("turn-1"),
      itemId,
      payload: { itemType: "retry", status: "completed", detail: "PRIVATE ERROR" },
    })[0];
    expect(start).toMatchObject({
      id: "provider-retry:codex:thread-1:retry:turn-1",
      summary: "Retrying provider request",
    });
    expect(end).toMatchObject({
      id: start?.id,
      summary: "Provider retry succeeded",
      payload: { status: "completed" },
    });
    expect(JSON.stringify([start, end])).not.toContain("PRIVATE");
  });

  it("preserves partial refinement counts without native content", () => {
    const [activity] = runtimeEventToActivities({
      ...base,
      type: "item.completed",
      eventId: EventId.make("refine-end"),
      turnId: TurnId.make("turn-1"),
      itemId: RuntimeItemId.make("refinement:turn-1"),
      payload: {
        itemType: "refinement",
        status: "completed",
        detail: "PRIVATE SUMMARY",
        data: { appliedCount: 2, failedCount: 1, native: "PRIVATE" },
      },
    });
    expect(activity).toMatchObject({
      id: "harness-refinement:codex:thread-1:refine-end",
      summary: "Harness refinement partially applied",
      payload: { status: "partial", appliedCount: 2, failedCount: 1 },
    });
    expect(JSON.stringify(activity)).not.toContain("PRIVATE");

    const [second] = runtimeEventToActivities({
      ...base,
      type: "item.completed",
      eventId: EventId.make("refine-end-2"),
      turnId: TurnId.make("turn-1"),
      payload: {
        itemType: "refinement",
        status: "completed",
        data: { appliedCount: 1, failedCount: 0 },
      },
    });
    expect(second?.id).toBe("harness-refinement:codex:thread-1:refine-end-2");
    expect(second?.id).not.toBe(activity?.id);
  });
});
