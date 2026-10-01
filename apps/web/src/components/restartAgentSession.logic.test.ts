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

// Production shape: ingestion upserts one row per instance and thread under a
// fixed id, so the projection only ever holds the latest update.
const nativeCompaction = (
  status: "idle" | "compacting",
  runStartedAt?: string,
  createdAt = "2026-10-01T00:00:02.000Z",
) =>
  ({
    id: EventId.make(`session-compaction:${instanceId}:thread-1`),
    kind: "session.compaction.updated",
    tone: "info",
    summary: "Session compaction updated",
    turnId: null,
    createdAt,
    payload: {
      ...(runStartedAt === undefined ? {} : { runStartedAt }),
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
      planRestartAgentSession({
        session: session(),
        activities: [nativeCompaction("compacting", "2026-10-01T00:00:01.000Z")],
      }),
    ).toEqual({
      kind: "busy",
      runningTurn: false,
      turnKey: null,
      compacting: true,
      compactionKey: "native:2026-10-01T00:00:01.000Z",
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
  const A = "2026-10-01T00:00:01.000Z";
  const B = "2026-10-01T00:00:04.000Z";
  const planFor = (row: OrchestrationThreadActivity) =>
    planRestartAgentSession({ session: session(), activities: [row] });

  it("allows the same native run and refuses a run that replaced it", () => {
    const confirmedPlan = planFor(nativeCompaction("compacting", A, "2026-10-01T00:00:01.000Z"));
    expect(confirmedPlan).toMatchObject({ kind: "busy", compactionKey: `native:${A}` });
    if (confirmedPlan.kind !== "busy") throw new Error("expected a busy plan");

    // A progresses: the upserted row changes but keeps its run start.
    const sameRun = planFor(nativeCompaction("compacting", A, "2026-10-01T00:00:02.000Z"));
    expect(restartPlanExceedsConfirmed(confirmedPlan, sameRun)).toBe(false);

    // A completed and B started; the completion row was overwritten by B.
    const replaced = planFor(nativeCompaction("compacting", B, "2026-10-01T00:00:04.000Z"));
    expect(replaced).toMatchObject({ kind: "busy", compactionKey: `native:${B}` });
    expect(restartPlanExceedsConfirmed(confirmedPlan, replaced)).toBe(true);
  });

  it("refuses a running compaction it cannot identify", () => {
    // Rows from an older server, or a run whose start was lost, have no key.
    const unidentified = planFor(nativeCompaction("compacting"));
    expect(unidentified).toMatchObject({ kind: "busy", compacting: true, compactionKey: null });
    if (unidentified.kind !== "busy") throw new Error("expected a busy plan");
    expect(restartPlanExceedsConfirmed(unidentified, unidentified)).toBe(true);
    const confirmedPlan = planFor(nativeCompaction("compacting", A));
    if (confirmedPlan.kind !== "busy") throw new Error("expected a busy plan");
    expect(restartPlanExceedsConfirmed(confirmedPlan, unidentified)).toBe(true);
  });
});
