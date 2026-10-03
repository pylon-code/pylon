import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  IsoDateTime,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type ProviderSession,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "../../orchestration-v2/ProviderAdapter.ts";
import { legacyAdapterV2Capabilities } from "./LegacyAdapterV2Bridge.ts";
import { makeLegacyRuntimeEventProjector } from "./LegacyRuntimeEventProjector.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";
import { mapPrimeAgentDaemonRuntimeEventDrafts } from "../prime/PrimeAgentDaemonRuntimeEvents.ts";

const driver = ProviderDriverKind.make("primeAgent");
const instanceId = ProviderInstanceId.make("prime-test");
const threadId = ThreadId.make("thread-prime");
const providerSessionId = ProviderSessionId.make("session-prime");
const nativeTurnId = TurnId.make("turn-native");
const time = IsoDateTime.make("2026-10-02T12:00:00.000Z");
const now = DateTime.makeUnsafe(time);
const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodeV2Event = Schema.decodeUnknownSync(ProviderAdapterV2Event);
let nextEventId = 0;
function event(
  type: string,
  payload: unknown,
  extra: Readonly<Record<string, unknown>> = {},
): ProviderRuntimeEvent {
  return decodeEvent({
    eventId: EventId.make(`event:${++nextEventId}`),
    provider: driver,
    providerInstanceId: instanceId,
    threadId,
    turnId: nativeTurnId,
    createdAt: time,
    type,
    payload,
    ...extra,
  });
}

function legacyAdapter<Error = never>(
  overrides: Partial<ProviderAdapterShape<Error>> = {},
): ProviderAdapterShape<Error> {
  const session: ProviderSession = {
    provider: driver,
    providerInstanceId: instanceId,
    threadId,
    status: "ready",
    runtimeMode: "full-access",
    cwd: "/workspace",
    model: "prime-model",
    createdAt: time,
    updatedAt: time,
  };
  return {
    provider: driver,
    capabilities: { sessionModelSwitch: "in-session", conversationRollback: "unsupported" },
    startSession: () => Effect.succeed(session),
    sendTurn: () => Effect.succeed({ threadId, turnId: nativeTurnId }),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    readThread: () => Effect.succeed({ threadId, turns: [] }),
    rollbackThread: () => Effect.succeed({ threadId, turns: [] }),
    stopSession: () => Effect.void,
    hasSession: () => Effect.succeed(true),
    listSessions: () => Effect.succeed([session]),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
    ...overrides,
  };
}

function fixture() {
  const capabilities = legacyAdapterV2Capabilities(legacyAdapter());
  const providerSession: OrchestrationV2ProviderSession = {
    id: providerSessionId,
    driver,
    providerInstanceId: instanceId,
    status: "ready",
    cwd: "/workspace",
    model: "prime-model",
    capabilities,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  const providerThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("thread-provider"),
    driver,
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const projector = makeLegacyRuntimeEventProjector({ providerSession, providerThread });
  const turnInput = makeTurnInput(providerThread);
  projector.prepareTurn(turnInput);
  return { projector, turnInput, providerThread };
}

function makeTurnInput(
  providerThread: OrchestrationV2ProviderThread,
  ordinal = 1,
): ProviderAdapterV2TurnInput {
  const modelSelection = { instanceId, model: "prime-model" };
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project-test"),
      title: "Prime bridge",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId,
    runId: RunId.make(`run:${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt:${ordinal}`),
    rootNodeId: NodeId.make(`node:${ordinal}`),
    providerThread,
    message: {
      messageId: MessageId.make(`message:${ordinal}`),
      text: "Run the task",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/workspace" },
  };
}

describe("legacy projector terminal ownership and usage", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "keeps native child items and nodes open after the root is %s",
    (state) => {
      const { projector, turnInput, providerThread } = fixture();
      const childId = NodeId.make(`${providerThread.id}:task:child`);
      projector.project(event("turn.started", {}));
      const childStarted = projector.project(
        event("task.started", { taskId: "child", description: "Native child" }),
      );
      expect(childStarted.find((row) => row.type === "subagent.updated")).toMatchObject({
        subagent: { id: childId, parentNodeId: turnInput.rootNodeId, status: "running" },
      });
      expect(childStarted.find((row) => row.type === "node.updated")).toMatchObject({
        node: {
          id: childId,
          parentNodeId: turnInput.rootNodeId,
          rootNodeId: turnInput.rootNodeId,
          status: "running",
        },
      });
      const toolStarted = projector.project(
        event(
          "item.started",
          {
            itemType: "command_execution",
            status: "inProgress",
            agentId: "child",
            data: { command: "work" },
          },
          { itemId: "child-tool" },
        ),
      );
      expect(toolStarted.find((row) => row.type === "node.updated")).toMatchObject({
        node: { parentNodeId: childId, rootNodeId: turnInput.rootNodeId, status: "running" },
      });
      const terminal = projector.project(event("turn.completed", { state }));
      expect(
        terminal.some(
          (row) =>
            row.type === "turn_item.updated" &&
            (row.turnItem.type === "subagent" || row.turnItem.type === "command_execution"),
        ),
      ).toBe(false);
      expect(
        terminal.some((row) => row.type === "node.updated" && row.node.kind === "subagent"),
      ).toBe(false);
      expect(projector.hasPendingBackgroundWork()).toBe(true);
      const progress = projector.project(
        event("task.progress", {
          taskId: "child",
          description: "Still running",
          summary: "Working",
        }),
      );
      expect(progress.find((row) => row.type === "turn_item.updated")).toMatchObject({
        turnItem: { type: "subagent", status: "running", completedAt: null },
      });
      const childTerminal = projector.project(
        event("task.completed", { taskId: "child", status: "completed" }),
      );
      expect(childTerminal.find((row) => row.type === "node.updated")).toMatchObject({
        node: { kind: "subagent", status: "completed" },
      });
      expect(
        childTerminal.find(
          (row) => row.type === "turn_item.updated" && row.turnItem.type === "command_execution",
        ),
      ).toMatchObject({ turnItem: { status: "completed", completedAt: now } });
      expect(
        childTerminal.find((row) => row.type === "node.updated" && row.node.kind === "tool_call"),
      ).toMatchObject({
        node: {
          parentNodeId: childId,
          rootNodeId: turnInput.rootNodeId,
          status: "completed",
          completedAt: now,
        },
      });
      expect(projector.hasPendingBackgroundWork()).toBe(false);
      for (const row of [
        ...childStarted,
        ...toolStarted,
        ...terminal,
        ...progress,
        ...childTerminal,
      ])
        decodeV2Event(row);
    },
  );

  it.each(["completed", "failed", "stopped"] as const)(
    "settles directly owned open tools when the native child is %s without overwriting item receipts",
    (status) => {
      const { projector } = fixture();
      projector.project(event("turn.started", {}));
      projector.project(event("task.started", { taskId: "child", description: "Native child" }));
      for (const itemId of ["open-tool", "finished-tool"])
        projector.project(
          event(
            "item.started",
            { itemType: "command_execution", agentId: "child", data: { command: "work" } },
            { itemId },
          ),
        );
      const finished = projector.project(
        event(
          "item.completed",
          { itemType: "command_execution", status: "completed", agentId: "child", data: {} },
          { itemId: "finished-tool" },
        ),
      );
      expect(finished.find((row) => row.type === "turn_item.updated")).toMatchObject({
        turnItem: { type: "command_execution", status: "completed", completedAt: now },
      });
      const terminal = projector.project(event("task.completed", { taskId: "child", status }));
      const expectedStatus = status === "stopped" ? "cancelled" : status;
      const tools = terminal.filter(
        (row) => row.type === "turn_item.updated" && row.turnItem.type === "command_execution",
      );
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        turnItem: {
          id: expect.stringContaining("open-tool"),
          status: expectedStatus,
          completedAt: now,
        },
      });
      expect(
        terminal.find((row) => row.type === "node.updated" && row.node.kind === "tool_call"),
      ).toMatchObject({ node: { status: expectedStatus, completedAt: now } });
      for (const row of [...finished, ...terminal]) decodeV2Event(row);
    },
  );

  it("keeps independent descendants running when their parent task completes", () => {
    const { projector, turnInput, providerThread } = fixture();
    const parentId = NodeId.make(`${providerThread.id}:task:parent`);
    const descendantId = NodeId.make(`${providerThread.id}:task:descendant`);
    projector.project(event("turn.started", {}));
    projector.project(event("task.started", { taskId: "parent", description: "Native parent" }));
    const descendantStarted = projector.project(
      event("task.started", {
        taskId: "descendant",
        parentAgentId: "parent",
        description: "Independent native descendant",
      }),
    );
    expect(descendantStarted.find((row) => row.type === "subagent.updated")).toMatchObject({
      subagent: { id: descendantId, parentNodeId: parentId, status: "running", completedAt: null },
    });
    expect(descendantStarted.find((row) => row.type === "node.updated")).toMatchObject({
      node: {
        id: descendantId,
        parentNodeId: parentId,
        rootNodeId: turnInput.rootNodeId,
        status: "running",
      },
    });
    for (const agentId of ["parent", "descendant"])
      projector.project(
        event(
          "item.started",
          { itemType: "command_execution", agentId, data: { command: "work" } },
          { itemId: `${agentId}-tool` },
        ),
      );
    projector.project(event("turn.completed", { state: "completed" }));
    const parentTerminal = projector.project(
      event("task.completed", { taskId: "parent", status: "completed" }),
    );
    expect(parentTerminal.filter((row) => row.type === "subagent.updated")).toMatchObject([
      { subagent: { id: parentId, status: "completed" } },
    ]);
    expect(parentTerminal.filter((row) => row.type === "node.updated")).toMatchObject([
      { node: { id: parentId, status: "completed" } },
      { node: { parentNodeId: parentId, kind: "tool_call", status: "completed" } },
    ]);
    expect(
      parentTerminal.filter(
        (row) => row.type === "turn_item.updated" && row.turnItem.type === "command_execution",
      ),
    ).toMatchObject([
      { turnItem: { id: expect.stringContaining("parent-tool"), status: "completed" } },
    ]);
    expect(projector.hasPendingBackgroundWork()).toBe(true);
    const progress = projector.project(
      event("task.progress", {
        taskId: "descendant",
        parentAgentId: "parent",
        description: "Continues after parent completion",
      }),
    );
    expect(progress.find((row) => row.type === "node.updated")).toMatchObject({
      node: { id: descendantId, parentNodeId: parentId, status: "running", completedAt: null },
    });
    const descendantTerminal = projector.project(
      event("task.completed", {
        taskId: "descendant",
        parentAgentId: "parent",
        status: "completed",
      }),
    );
    expect(
      descendantTerminal.find(
        (row) => row.type === "node.updated" && row.node.kind === "tool_call",
      ),
    ).toMatchObject({
      node: { parentNodeId: descendantId, status: "completed", completedAt: now },
    });
    expect(projector.hasPendingBackgroundWork()).toBe(false);
    for (const row of [...descendantStarted, ...parentTerminal, ...progress, ...descendantTerminal])
      decodeV2Event(row);
  });

  const usage = {
    inputTokens: 11,
    outputTokens: 7,
    cachedInputTokens: 3,
    cacheWriteTokens: 2,
    totalTokens: 23,
    totalCostUsd: 0.01,
  };
  it("normalizes the actual Prime mapper's terminal usage with cache reads and writes", () => {
    const { projector } = fixture();
    projector.project(event("turn.started", {}));
    const drafts = mapPrimeAgentDaemonRuntimeEventDrafts({
      provider: driver,
      providerInstanceId: instanceId,
      threadId,
      turnId: nativeTurnId,
      event: {
        _tag: "RunCompleted",
        messages: [
          {
            role: "assistant",
            timestamp: 1,
            provider: "anthropic",
            model: "prime-model",
            text: "Done",
            thinking: "",
            toolCalls: [],
            usage,
            stopReason: "stop",
          },
        ],
      },
    });
    const output = drafts.flatMap((draft) =>
      projector.project(
        decodeEvent({
          ...draft,
          eventId: EventId.make(`mapped:${++nextEventId}`),
          createdAt: time,
        }),
      ),
    );
    for (const row of output) decodeV2Event(row);
    expect(projector.snapshot().providerTurns[0]?.turnTokenUsage).toEqual({
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 16,
      outputTokens: 7,
      cachedInputTokens: 3,
      cacheCreationTokens: 2,
    });
  });

  it.each([
    { ...usage, totalTokens: 99 },
    { ...usage, inputTokens: -1 },
    { ...usage, outputTokens: 1.5 },
    { ...usage, cachedInputTokens: "3" },
    { ...usage, cacheWriteTokens: undefined },
    { ...usage, inputTokens: Number.MAX_SAFE_INTEGER },
  ])("does not invent complete totals from malformed or incoherent legacy usage %j", (rawUsage) => {
    const { projector } = fixture();
    projector.project(event("turn.started", {}));
    projector.project(event("turn.completed", { state: "completed", usage: rawUsage }));
    expect(projector.snapshot().providerTurns[0]?.turnTokenUsage).toEqual({
      usageScope: "main_agent",
      usageStatus: "unavailable",
      hasSubagents: false,
    });
  });

  it("does not attribute descendant-inclusive legacy counts to the main agent", () => {
    const { projector } = fixture();
    projector.project(event("turn.started", {}));
    projector.project(event("task.started", { taskId: "child", description: "Child" }));
    projector.project(event("task.completed", { taskId: "child", status: "completed" }));
    projector.project(event("turn.completed", { state: "completed", usage }));
    expect(projector.snapshot().providerTurns[0]?.turnTokenUsage).toEqual({
      usageScope: "main_agent",
      usageStatus: "unavailable",
      hasSubagents: true,
    });
  });

  it("marks a later turn's cumulative usage unavailable when inherited children drain during it", () => {
    const { projector, providerThread } = fixture();
    projector.project(event("turn.started", {}));
    projector.project(event("task.started", { taskId: "child", description: "Background child" }));
    projector.project(event("turn.completed", { state: "completed", usage }));
    projector.prepareTurn(makeTurnInput(providerThread, 2));
    const secondTurn = TurnId.make("native-second");
    projector.project(event("turn.started", {}, { turnId: secondTurn }));
    projector.project(event("task.completed", { taskId: "child", status: "completed" }));
    projector.project(
      event("turn.completed", { state: "completed", usage }, { turnId: secondTurn }),
    );
    expect(projector.snapshot().providerTurns[1]?.turnTokenUsage).toEqual({
      usageScope: "main_agent",
      usageStatus: "unavailable",
      hasSubagents: true,
    });
  });

  it("preserves explicitly normalized main-agent usage even when native children exist", () => {
    const { projector } = fixture();
    const tokenUsage = {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: true,
      inputTokens: 5,
      outputTokens: 2,
    } as const;
    projector.project(event("turn.started", {}));
    projector.project(event("task.started", { taskId: "child", description: "Child" }));
    projector.project(event("turn.completed", { state: "completed", usage, tokenUsage }));
    expect(projector.snapshot().providerTurns[0]?.turnTokenUsage).toEqual(tokenUsage);
  });
});
