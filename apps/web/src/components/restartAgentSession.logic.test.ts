import {
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  planRestartAgentSession,
  restartAgentSessionConfirmMessage,
  restartPlanExceedsConfirmed,
  type RestartAgentSessionPlan,
} from "./restartAgentSession.logic";

const instanceId = ProviderInstanceId.make("prime-work");

const session = (overrides: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId: ThreadId.make("thread-1"),
  status: "ready",
  providerName: "primeAgent",
  providerInstanceId: instanceId,
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const inputQueue = (steeringCount: number, followUpCount: number) =>
  ({
    id: EventId.make(`queue-${steeringCount}-${followUpCount}`),
    kind: "session.input-queue.updated",
    tone: "info",
    summary: "Session input queue updated",
    turnId: null,
    createdAt: "2026-10-01T00:00:01.000Z",
    payload: {
      provider: ProviderDriverKind.make("primeAgent"),
      providerInstanceId: instanceId,
      steeringCount,
      followUpCount,
    },
  }) as OrchestrationThreadActivity;

const nativeCompaction = (status: "idle" | "compacting", id = `compaction-${status}`) =>
  ({
    id: EventId.make(id),
    kind: "session.compaction.updated",
    tone: "info",
    summary: "Session compaction updated",
    turnId: null,
    createdAt: "2026-10-01T00:00:02.000Z",
    payload: {
      provider: ProviderDriverKind.make("primeAgent"),
      providerInstanceId: instanceId,
      available: true,
      status,
      abortable: status === "compacting",
      autoCompactionEnabled: true,
      autoCompactionWritable: true,
      manualCompactionSettable: status === "idle",
      autoCompactionScope: "session-and-provider-default",
    },
  }) as OrchestrationThreadActivity;

describe("planRestartAgentSession", () => {
  it("restarts without asking when nothing is running or queued", () => {
    expect(planRestartAgentSession({ session: null, activities: [] })).toEqual({ kind: "idle" });
    expect(planRestartAgentSession({ session: session(), activities: [inputQueue(0, 0)] })).toEqual(
      { kind: "idle" },
    );
    expect(
      planRestartAgentSession({ session: session({ status: "stopped" }), activities: [] }),
    ).toEqual({ kind: "idle" });
  });

  it("treats a running turn or a pending admission as busy", () => {
    expect(
      planRestartAgentSession({
        session: session({ status: "running", activeTurnId: TurnId.make("turn-1") }),
        activities: [],
      }),
    ).toEqual({
      kind: "busy",
      runningTurn: true,
      turnKey: "turn-1",
      compacting: false,
      compactionKey: null,
      queuedMessages: 0,
    });
    expect(
      planRestartAgentSession({
        session: session({ pendingTurnRequestId: CommandId.make("request-1") }),
        activities: [],
      }),
    ).toMatchObject({ kind: "busy", runningTurn: true });
  });

  it("counts queued provider input and compaction-queued messages", () => {
    expect(
      planRestartAgentSession({
        session: session({
          compactionQueue: {
            requestId: CommandId.make("compact-1"),
            phase: "running",
            queued: [
              {
                requestId: CommandId.make("queued-1"),
                messageId: MessageId.make("message-1"),
                text: "next",
                attachments: [],
                modelSelection: { instanceId, model: "prime" },
                runtimeMode: "full-access",
                interactionMode: "default",
                sourceEpoch: 0,
                createdAt: "2026-10-01T00:00:00.000Z",
              },
            ],
          },
        }),
        activities: [inputQueue(1, 2)],
      }),
    ).toEqual({
      kind: "busy",
      runningTurn: false,
      turnKey: null,
      compacting: true,
      compactionKey: "slash:compact-1",
      queuedMessages: 4,
    });
  });

  it("treats native compaction in progress as busy", () => {
    expect(
      planRestartAgentSession({ session: session(), activities: [nativeCompaction("compacting")] }),
    ).toEqual({
      kind: "busy",
      runningTurn: false,
      turnKey: null,
      compacting: true,
      compactionKey: "native:compaction-compacting",
      queuedMessages: 0,
    });
    expect(
      planRestartAgentSession({ session: session(), activities: [nativeCompaction("idle")] }),
    ).toEqual({ kind: "idle" });
  });

  it("does not offer a second stop while one is pending", () => {
    expect(
      planRestartAgentSession({
        session: session({ pendingStopRequestId: CommandId.make("stop-1") }),
        activities: [],
      }),
    ).toEqual({ kind: "stopping" });
    expect(
      planRestartAgentSession({
        session: session({ status: "stopped", pendingStopRequestId: CommandId.make("stop-1") }),
        activities: [],
      }),
    ).toEqual({ kind: "stopping" });
  });
});

describe("restartAgentSessionConfirmMessage", () => {
  it("names what will stop and how many messages are cancelled", () => {
    expect(
      restartAgentSessionConfirmMessage({
        kind: "busy",
        runningTurn: true,
        turnKey: "turn-1",
        compacting: true,
        compactionKey: null,
        queuedMessages: 2,
      }),
    ).toBe(
      [
        "Restart the agent session?",
        "This stops the running turn and context compaction.",
        "2 queued messages will be cancelled.",
      ].join("\n"),
    );
    expect(
      restartAgentSessionConfirmMessage({
        kind: "busy",
        runningTurn: false,
        turnKey: null,
        compacting: false,
        compactionKey: null,
        queuedMessages: 1,
      }),
    ).toBe(["Restart the agent session?", "1 queued message will be cancelled."].join("\n"));
  });
});

describe("restartPlanExceedsConfirmed", () => {
  const confirmed = {
    kind: "busy",
    runningTurn: true,
    turnKey: "turn-a",
    compacting: false,
    compactionKey: null,
    queuedMessages: 0,
  } as const satisfies RestartAgentSessionPlan;

  it("allows the same or less work, including a thread that went idle", () => {
    expect(restartPlanExceedsConfirmed(confirmed, confirmed)).toBe(false);
    expect(restartPlanExceedsConfirmed(confirmed, { kind: "idle" })).toBe(false);
    expect(
      restartPlanExceedsConfirmed(confirmed, { ...confirmed, runningTurn: false, turnKey: null }),
    ).toBe(false);
  });

  it("refuses a different turn, new compaction, or more queued messages", () => {
    expect(restartPlanExceedsConfirmed(confirmed, { ...confirmed, turnKey: "turn-b" })).toBe(true);
    expect(
      restartPlanExceedsConfirmed(confirmed, {
        ...confirmed,
        compacting: true,
        compactionKey: "native:c-1",
      }),
    ).toBe(true);
    expect(restartPlanExceedsConfirmed(confirmed, { ...confirmed, queuedMessages: 1 })).toBe(true);
    expect(
      restartPlanExceedsConfirmed(
        { ...confirmed, runningTurn: false, turnKey: null, queuedMessages: 2 },
        { ...confirmed, queuedMessages: 2 },
      ),
    ).toBe(true);
  });
});

describe("compaction identity", () => {
  it("refuses a native compaction that replaced the confirmed one", () => {
    const confirmedPlan = planRestartAgentSession({
      session: session(),
      activities: [
        nativeCompaction("compacting", "a-start"),
        nativeCompaction("compacting", "a-progress"),
      ],
    });
    expect(confirmedPlan).toMatchObject({ kind: "busy", compactionKey: "native:a-start" });
    if (confirmedPlan.kind !== "busy") throw new Error("expected a busy plan");

    // Compaction A continues: same run, restart may proceed.
    const sameRun = planRestartAgentSession({
      session: session(),
      activities: [
        nativeCompaction("compacting", "a-start"),
        nativeCompaction("compacting", "a-progress"),
        nativeCompaction("compacting", "a-more"),
      ],
    });
    expect(restartPlanExceedsConfirmed(confirmedPlan, sameRun)).toBe(false);

    // A finished and another client started B before the confirmation.
    const replaced = planRestartAgentSession({
      session: session(),
      activities: [
        nativeCompaction("compacting", "a-start"),
        nativeCompaction("idle", "a-done"),
        nativeCompaction("compacting", "b-start"),
      ],
    });
    expect(replaced).toMatchObject({ kind: "busy", compactionKey: "native:b-start" });
    expect(restartPlanExceedsConfirmed(confirmedPlan, replaced)).toBe(true);
  });
});
