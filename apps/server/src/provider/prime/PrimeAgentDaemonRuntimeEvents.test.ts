// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import type { PrimeDaemonEvent } from "./PrimeAgentDaemonEvents.ts";
import {
  mapPrimeAgentContextUsageDraft,
  mapPrimeAgentDaemonRuntimeEventDrafts,
} from "./PrimeAgentDaemonRuntimeEvents.ts";

const provider = ProviderDriverKind.make("primeAgent");
const providerInstanceId = ProviderInstanceId.make("primeAgent_default");
const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");

const context = { provider, providerInstanceId, threadId, turnId };

const usage = {
  inputTokens: 11,
  outputTokens: 7,
  cachedInputTokens: 3,
  cacheWriteTokens: 2,
  totalTokens: 23,
  totalCostUsd: 0.0125,
};

function assistant(
  overrides: Partial<Extract<PrimeDaemonEvent, { readonly _tag: "TurnCompleted" }>["message"]> = {},
): Extract<PrimeDaemonEvent, { readonly _tag: "TurnCompleted" }>["message"] {
  return {
    role: "assistant",
    timestamp: 1,
    provider: "openai",
    model: "gpt-test",
    text: "done",
    thinking: "",
    toolCalls: [],
    usage,
    stopReason: "stop",
    ...overrides,
  };
}

describe("mapPrimeAgentDaemonRuntimeEventDrafts", () => {
  it("maps the assistant item and text stream with stable canonical identity", () => {
    expect(
      mapPrimeAgentDaemonRuntimeEventDrafts({
        ...context,
        event: { _tag: "MessageStarted", message: assistant() },
      }),
    ).toEqual([
      {
        provider,
        providerInstanceId,
        threadId,
        turnId,
        type: "item.started",
        itemId: RuntimeItemId.make("assistant:turn-1"),
        payload: { itemType: "assistant_message", status: "inProgress" },
      },
    ]);

    expect(
      mapPrimeAgentDaemonRuntimeEventDrafts({
        ...context,
        event: {
          _tag: "AssistantStream",
          phase: "delta",
          kind: "text",
          contentIndex: 2,
          delta: "hello",
        },
      }),
    ).toEqual([
      {
        provider,
        providerInstanceId,
        threadId,
        turnId,
        type: "content.delta",
        itemId: RuntimeItemId.make("assistant:turn-1"),
        payload: { streamKind: "assistant_text", delta: "hello", contentIndex: 2 },
      },
    ]);

    expect(
      mapPrimeAgentDaemonRuntimeEventDrafts({
        ...context,
        event: { _tag: "MessageCompleted", message: assistant() },
      }),
    ).toEqual([
      {
        provider,
        providerInstanceId,
        threadId,
        turnId,
        type: "item.completed",
        itemId: RuntimeItemId.make("assistant:turn-1"),
        payload: { itemType: "assistant_message", status: "completed" },
      },
    ]);
  });

  it("backfills final assistant text only when streaming was explicitly absent", () => {
    const event = {
      _tag: "MessageCompleted",
      message: assistant({ text: "final answer" }),
    } as const;

    expect(
      mapPrimeAgentDaemonRuntimeEventDrafts({
        ...context,
        assistantTextStreamed: false,
        event,
      }),
    ).toEqual([
      {
        provider,
        providerInstanceId,
        threadId,
        turnId,
        type: "content.delta",
        itemId: RuntimeItemId.make("assistant:turn-1"),
        payload: { streamKind: "assistant_text", delta: "final answer" },
      },
      {
        provider,
        providerInstanceId,
        threadId,
        turnId,
        type: "item.completed",
        itemId: RuntimeItemId.make("assistant:turn-1"),
        payload: { itemType: "assistant_message", status: "completed" },
      },
    ]);

    for (const assistantTextStreamed of [undefined, true] as const) {
      const drafts = mapPrimeAgentDaemonRuntimeEventDrafts({
        ...context,
        assistantTextStreamed,
        event,
      });
      expect(drafts.map((draft) => draft.type)).toEqual(["item.completed"]);
    }
  });

  it("projects only bounded final provider-exposed reasoning", () => {
    const map = (event: PrimeDaemonEvent) =>
      mapPrimeAgentDaemonRuntimeEventDrafts({ ...context, event });

    expect(
      map({ _tag: "AssistantStream", phase: "start", kind: "thinking", contentIndex: 4 }),
    ).toEqual([]);
    expect(
      map({
        _tag: "AssistantStream",
        phase: "delta",
        kind: "thinking",
        contentIndex: 4,
        delta: "private incremental thought",
      }),
    ).toEqual([]);
    expect(
      map({
        _tag: "AssistantStream",
        phase: "end",
        kind: "thinking",
        contentIndex: 4,
        content: "provider-exposed reasoning",
      }),
    ).toEqual([
      {
        provider,
        providerInstanceId,
        threadId,
        turnId,
        type: "item.completed",
        itemId: RuntimeItemId.make("reasoning:turn-1"),
        payload: {
          itemType: "reasoning",
          status: "completed",
          title: "Reasoning",
          detail: "provider-exposed reasoning",
        },
      },
    ]);
    const long = map({
      _tag: "AssistantStream",
      phase: "end",
      kind: "thinking",
      contentIndex: 4,
      content: "x".repeat(5_000),
    });
    expect(long[0]?.payload).toMatchObject({ detail: "x".repeat(4_000) });
  });

  it("maps tool execution lifecycle, classifies clear names, and keeps only safe input", () => {
    expect(
      mapPrimeAgentDaemonRuntimeEventDrafts({
        ...context,
        event: {
          _tag: "ToolStarted",
          toolCallId: "tool-1",
          toolName: "functions.ipython",
          input: { code: "print(1)", count: 2, ok: true, empty: null },
        },
      }),
    ).toEqual([
      {
        provider,
        providerInstanceId,
        threadId,
        turnId,
        type: "item.started",
        itemId: RuntimeItemId.make("tool-1"),
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "functions.ipython",
          data: { code: "print(1)", count: 2, ok: true, empty: null },
        },
      },
    ]);

    expect(
      mapPrimeAgentDaemonRuntimeEventDrafts({
        ...context,
        event: {
          _tag: "ToolProgress",
          toolCallId: "tool-2",
          toolName: "apply_patch",
          text: "changed a.ts",
        },
      })[0],
    ).toMatchObject({
      type: "item.updated",
      itemId: RuntimeItemId.make("tool-2"),
      payload: { itemType: "file_change", status: "inProgress", detail: "changed a.ts" },
    });

    expect(
      mapPrimeAgentDaemonRuntimeEventDrafts({
        ...context,
        event: {
          _tag: "ToolCompleted",
          toolCallId: "tool-3",
          toolName: "editorial_review",
          text: "no",
          isError: true,
        },
      })[0],
    ).toMatchObject({
      type: "item.completed",
      itemId: RuntimeItemId.make("tool-3"),
      payload: { itemType: "dynamic_tool_call", status: "failed", detail: "no" },
    });
  });

  it("keeps provider turns open until the daemon run completes", () => {
    expect(
      mapPrimeAgentDaemonRuntimeEventDrafts({
        ...context,
        event: {
          _tag: "TurnCompleted",
          message: assistant({ stopReason: "toolUse" }),
          toolResults: [],
        },
      }),
    ).toEqual([]);

    const finalUsage = {
      inputTokens: 5,
      outputTokens: 2,
      cachedInputTokens: 1,
      cacheWriteTokens: 0,
      totalTokens: 8,
      totalCostUsd: 0.003,
    };
    expect(
      mapPrimeAgentDaemonRuntimeEventDrafts({
        ...context,
        event: {
          _tag: "RunCompleted",
          messages: [
            assistant({ stopReason: "toolUse" }),
            {
              role: "toolResult",
              timestamp: 2,
              toolCallId: "tool-1",
              toolName: "proof",
              text: "done",
              imageMimeTypes: [],
              isError: false,
            },
            assistant({ text: "final", usage: finalUsage }),
          ],
        },
      }),
    ).toEqual([
      {
        provider,
        providerInstanceId,
        threadId,
        turnId,
        type: "turn.completed",
        payload: {
          state: "completed",
          stopReason: "stop",
          usage: {
            inputTokens: 16,
            outputTokens: 9,
            cachedInputTokens: 4,
            cacheWriteTokens: 2,
            totalTokens: 31,
          },
          totalCostUsd: 0.0155,
        },
      },
      {
        provider,
        providerInstanceId,
        threadId,
        turnId,
        type: "session.state.changed",
        payload: { state: "ready" },
      },
    ]);
  });

  it("maps authoritative context usage without conflating turn or cumulative totals", () => {
    expect(
      mapPrimeAgentContextUsageDraft({
        provider,
        providerInstanceId,
        threadId,
        stats: { contextUsage: { usedTokens: 320, maxTokens: 200_000 } },
        compactsAutomatically: true,
      }),
    ).toEqual({
      provider,
      providerInstanceId,
      threadId,
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 320,
          maxTokens: 200_000,
          compactsAutomatically: true,
        },
      },
    });
  });

  it("clears context usage when Prime reports unknown or unavailable context", () => {
    expect(
      mapPrimeAgentContextUsageDraft({
        provider,
        providerInstanceId,
        threadId,
        stats: { contextUsage: { usedTokens: null, maxTokens: 200_000 } },
        compactsAutomatically: false,
      }),
    ).toMatchObject({
      type: "thread.token-usage.cleared",
      payload: { reason: "unknown" },
    });
    expect(
      mapPrimeAgentContextUsageDraft({
        provider,
        providerInstanceId,
        threadId,
        stats: {},
        compactsAutomatically: true,
      }),
    ).toMatchObject({
      type: "thread.token-usage.cleared",
      payload: { reason: "unavailable" },
    });
  });

  it("does not complete a replayed run and fails an active run with no assistant", () => {
    expect(
      mapPrimeAgentDaemonRuntimeEventDrafts({
        provider,
        providerInstanceId,
        threadId,
        event: { _tag: "RunCompleted", messages: [assistant()] },
      }),
    ).toEqual([
      {
        provider,
        providerInstanceId,
        threadId,
        type: "session.state.changed",
        payload: { state: "ready" },
      },
    ]);

    expect(
      mapPrimeAgentDaemonRuntimeEventDrafts({
        ...context,
        event: { _tag: "RunCompleted", messages: [] },
      }),
    ).toEqual([
      {
        provider,
        providerInstanceId,
        threadId,
        turnId,
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: "Prime Agent completed the run without an assistant message.",
        },
      },
      {
        provider,
        providerInstanceId,
        threadId,
        turnId,
        type: "session.state.changed",
        payload: { state: "ready" },
      },
    ]);
  });

  it("does not turn aborted or error run endings into successful turns", () => {
    const aborted = mapPrimeAgentDaemonRuntimeEventDrafts({
      ...context,
      event: {
        _tag: "RunCompleted",
        messages: [assistant({ stopReason: "toolUse" }), assistant({ stopReason: "aborted" })],
      },
    });
    expect(aborted[0]).toMatchObject({ type: "turn.completed", payload: { state: "cancelled" } });

    const failed = mapPrimeAgentDaemonRuntimeEventDrafts({
      ...context,
      event: {
        _tag: "RunCompleted",
        messages: [
          assistant({ stopReason: "toolUse" }),
          assistant({ stopReason: "error", errorMessage: "quota exhausted" }),
        ],
      },
    });
    expect(failed[0]).toMatchObject({
      type: "turn.completed",
      payload: { state: "failed", errorMessage: "quota exhausted" },
    });

    expect(
      mapPrimeAgentDaemonRuntimeEventDrafts({
        ...context,
        event: { _tag: "RetryCompleted", success: false, attempt: 3, finalError: "offline" },
      }),
    ).toEqual([
      {
        provider,
        providerInstanceId,
        threadId,
        turnId,
        type: "runtime.error",
        payload: { message: "offline", class: "provider_error" },
      },
    ]);
  });

  it("maps child snapshots to timeline-bypassed task lifecycle rows", () => {
    const running = mapPrimeAgentDaemonRuntimeEventDrafts({
      ...context,
      event: {
        _tag: "ChildUpdated",
        child: {
          id: "child-1",
          parentId: "parent-1",
          activeSessionId: "private-session",
          sessionName: "private-name",
          model: "gpt-child",
          label: "Review tests",
          status: "running",
          durationMs: 250,
          toolUseCount: 4,
          tokenCount: 90,
          activity: { kind: "executing", toolName: "bash" },
        },
      },
    });
    expect(running).toEqual([
      {
        provider,
        providerInstanceId,
        threadId,
        turnId,
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make("child-1"),
          description: "Review tests",
          status: "running",
          typedUsage: { totalTokens: 90, toolUses: 4, durationMs: 250 },
          lastToolName: "bash",
          taskType: "subagent",
          agentKind: "agent",
          title: "Review tests",
          model: "gpt-child",
          parentAgentId: "parent-1",
          timelineBypass: true,
        },
      },
    ]);
    expect(JSON.stringify(running)).not.toContain("private-session");
    expect(JSON.stringify(running)).not.toContain("private-name");

    const terminal = mapPrimeAgentDaemonRuntimeEventDrafts({
      ...context,
      event: {
        _tag: "ChildUpdated",
        child: {
          id: "child-1",
          parentId: "parent-1",
          model: "gpt-child",
          label: "Review tests",
          status: "error",
          tokenCount: 100,
          error: "test failure",
        },
      },
    });
    expect(terminal[0]).toMatchObject({
      type: "task.completed",
      payload: {
        taskId: RuntimeTaskId.make("child-1"),
        status: "failed",
        summary: "test failure",
        typedUsage: { totalTokens: 100 },
        timelineBypass: true,
      },
    });
  });

  it("never includes native raw payloads and ignores replay, presentation, and duplicate streams", () => {
    const ignoredEvents: ReadonlyArray<PrimeDaemonEvent> = [
      { _tag: "TurnStarted" },
      {
        _tag: "AssistantStream",
        phase: "end",
        kind: "toolCall",
        contentIndex: 1,
        toolCall: { id: "tool-1", name: "bash" },
      },
      { _tag: "BashOutput", chunk: "duplicate" },
      {
        _tag: "SessionResynced",
        state: {
          sessionId: "native-session",
          cwd: "/private/session/path",
          isStreaming: false,
          isCompacting: false,
          isBashRunning: false,
          retryAttempt: 0,
          thinkingLevel: "medium",
          serviceTier: null,
          messageCount: 1,
          autoCompactionEnabled: true,
        },
        messages: [assistant()],
        children: [],
      },
      { _tag: "Ignored", reason: "unknown-event", sourceType: "native/private" },
    ];

    for (const event of ignoredEvents) {
      expect(mapPrimeAgentDaemonRuntimeEventDrafts({ ...context, event })).toEqual([]);
    }

    const mapped = mapPrimeAgentDaemonRuntimeEventDrafts({
      ...context,
      event: { _tag: "ToolProgress", toolCallId: "tool", toolName: "bash", text: "ok" },
    });
    expect(JSON.stringify(mapped)).not.toContain('"raw"');
    expect(JSON.stringify(mapped)).not.toContain("/private/session/path");
  });
});
