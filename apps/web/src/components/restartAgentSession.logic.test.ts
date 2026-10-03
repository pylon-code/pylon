import { RunId, ProviderThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  makeThreadFixture,
  makeThreadProjectionFixture,
  makeStreamingTimelineFixture,
} from "../test-fixtures";
import {
  planRestartAgentSession,
  restartAgentSessionConfirmMessage,
  restartPlanExceedsConfirmed,
  type RestartAgentSessionPlan,
} from "./restartAgentSession.logic";

const idleThread = makeThreadFixture();
const busyThread = makeThreadFixture({
  runtime: {
    status: "running",
    activeRunId: RunId.make("run-a"),
    providerInstanceId: idleThread.providerInstanceId,
    providerName: "Codex",
    lastError: null,
    updatedAt: idleThread.updatedAt,
  },
  activeProviderThreadId: ProviderThreadId.make("provider-thread-a"),
});
const busyPlan: Extract<RestartAgentSessionPlan, { kind: "busy" }> = {
  kind: "busy",
  sessionKey: "session-a",
  runningTurn: true,
  turnKey: "run-a",
  compacting: false,
  compactionKey: null,
  queuedMessages: 0,
  detailsKnown: true,
};

describe("native V2 restart plan", () => {
  it("leaves an idle thread without a confirmation", () => {
    expect(planRestartAgentSession(idleThread, makeThreadProjectionFixture())).toEqual({
      kind: "idle",
    });
  });
  it("identifies running work by app run and provider conversation", () => {
    expect(planRestartAgentSession(busyThread, makeThreadProjectionFixture())).toMatchObject({
      kind: "busy",
      sessionKey: "provider-thread-a",
      runningTurn: true,
      turnKey: "run-a",
      compacting: false,
      detailsKnown: true,
    });
  });
  it("requires known detail before stopping live work after a dialog", () => {
    expect(restartPlanExceedsConfirmed(busyPlan, planRestartAgentSession(busyThread))).toBe(true);
  });
  it("identifies each compaction entity separately", () => {
    const projection = makeThreadProjectionFixture();
    const source = makeStreamingTimelineFixture().visibleTurnItems[0]!.item;
    const compaction = {
      id: TurnItemId.make("compaction-a"),
      threadId: source.threadId,
      runId: source.runId,
      nodeId: source.nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: source.ordinal,
      title: null,
      startedAt: source.startedAt,
      completedAt: null,
      updatedAt: source.updatedAt,
      type: "compaction" as const,
      status: "running" as const,
      driver: null,
    };
    const plan = planRestartAgentSession(idleThread, { ...projection, turnItems: [compaction] });
    expect(plan).toMatchObject({ kind: "busy", compacting: true, compactionKey: "compaction-a" });
    if (plan.kind !== "busy") throw new Error("Expected busy compaction");
    const replaced = planRestartAgentSession(idleThread, {
      ...projection,
      turnItems: [{ ...compaction, id: TurnItemId.make("compaction-b") }],
    });
    expect(restartPlanExceedsConfirmed(plan, replaced)).toBe(true);
  });
});

describe("restart confirmation ownership", () => {
  it("accepts the same run and rejects replacements or unconfirmed work", () => {
    expect(restartPlanExceedsConfirmed(busyPlan, busyPlan)).toBe(false);
    expect(restartPlanExceedsConfirmed(busyPlan, { ...busyPlan, sessionKey: "session-b" })).toBe(
      true,
    );
    expect(restartPlanExceedsConfirmed(busyPlan, { ...busyPlan, turnKey: "run-b" })).toBe(true);
    expect(restartPlanExceedsConfirmed(busyPlan, { ...busyPlan, queuedMessages: 1 })).toBe(true);
    expect(restartPlanExceedsConfirmed(busyPlan, { ...busyPlan, compacting: true })).toBe(true);
    expect(restartPlanExceedsConfirmed(busyPlan, { kind: "idle" })).toBe(false);
  });
  it("describes native V2 detach without claiming queue cancellation", () => {
    const message = restartAgentSessionConfirmMessage({ ...busyPlan, queuedMessages: 2 });
    expect(message).toContain("may interrupt the running run");
    expect(message).toContain("2 queued messages remain queued");
    expect(message).not.toContain("cancelled");
  });
});
