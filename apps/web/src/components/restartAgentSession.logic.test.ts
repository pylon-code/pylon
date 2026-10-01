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

const nativeCompaction = (status: "idle" | "compacting") =>
  ({
    id: EventId.make(`compaction-${status}`),
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
    ).toEqual({ kind: "busy", runningTurn: true, compacting: false, queuedMessages: 0 });
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
    ).toEqual({ kind: "busy", runningTurn: false, compacting: true, queuedMessages: 4 });
  });

  it("treats native compaction in progress as busy", () => {
    expect(
      planRestartAgentSession({ session: session(), activities: [nativeCompaction("compacting")] }),
    ).toEqual({ kind: "busy", runningTurn: false, compacting: true, queuedMessages: 0 });
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
  });
});

describe("restartAgentSessionConfirmMessage", () => {
  it("names what will stop and how many messages are cancelled", () => {
    expect(
      restartAgentSessionConfirmMessage({
        kind: "busy",
        runningTurn: true,
        compacting: true,
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
        compacting: false,
        queuedMessages: 1,
      }),
    ).toBe(["Restart the agent session?", "1 queued message will be cancelled."].join("\n"));
  });
});
