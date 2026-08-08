// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import { decodePrimeAgentDaemonEvent } from "./PrimeAgentDaemonEvents.ts";

const usage = {
  input: 12,
  output: 7,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: 24,
  cost: {
    input: 0.001,
    output: 0.002,
    cacheRead: 0.0001,
    cacheWrite: 0.0002,
    total: 0.0033,
  },
};

function assistant(content: ReadonlyArray<Record<string, unknown>> = []) {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    responseId: "msg_123",
    usage,
    stopReason: "stop",
    timestamp: 1_762_000_000_000,
  };
}

const goal = {
  active: true,
  status: "active",
  goalId: "goal-1",
  objective: "Finish the integration",
  tokenBudget: 50_000,
  tokensUsed: 1_200,
  timeUsedSeconds: 90,
  continuationsUsed: 2,
};

const actions = {
  queuedCount: 2,
  steering: ["Focus on errors"],
  followUps: ["Summarize"],
  active: { kind: "session_command", phase: "running", label: "/compact" },
};

const state = {
  activeSessionId: "active-1",
  cwd: "/work/project",
  thinkingLevel: "high",
  serviceTier: "priority",
  isStreaming: true,
  isCompacting: false,
  isBashRunning: false,
  retryAttempt: 0,
  sessionId: "session-1",
  sessionName: "daemon-events",
  messageCount: 3,
  sessionActions: actions,
  goal,
  recap: "Implementing the daemon adapter",
};

const child = {
  id: "child-1",
  parentId: "root",
  activeSessionId: "active-child",
  sessionName: "schema-review",
  model: "openai/gpt-5.3-codex",
  label: "Review schemas",
  status: "running",
  durationMs: 1200,
  answerPreview: "Checking event boundaries",
  toolUseCount: 4,
  tokenCount: 8000,
  recap: "Reviewing",
  sessionDir: "/tmp/child",
  activity: { kind: "executing", toolName: "ipython" },
};

function sessionEvent(event: Record<string, unknown>) {
  return { type: "session_event", event };
}

describe("PrimeAgentDaemonEvents", () => {
  it("decodes real-shaped text and thinking deltas without a partial field", () => {
    expect(
      decodePrimeAgentDaemonEvent(
        sessionEvent({
          type: "message_update",
          message: assistant([{ type: "text", text: "DA" }]),
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "DA" },
        }),
      ),
    ).toEqual({
      _tag: "AssistantStream",
      phase: "delta",
      kind: "text",
      contentIndex: 0,
      delta: "DA",
    });

    expect(
      decodePrimeAgentDaemonEvent(
        sessionEvent({
          type: "message_update",
          message: assistant([{ type: "thinking", thinking: "check" }]),
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "check",
          },
        }),
      ),
    ).toMatchObject({ _tag: "AssistantStream", kind: "thinking", delta: "check" });
  });

  it("maps tool-call stream completion and bounds tool input to safe scalar fields", () => {
    const event = decodePrimeAgentDaemonEvent(
      sessionEvent({
        type: "message_update",
        message: assistant([
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
        ]),
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: {
              command: "ls",
              timeout: 1000,
              nested: { secret: "not retained" },
            },
          },
        },
      }),
    );

    expect(event).toEqual({
      _tag: "AssistantStream",
      phase: "end",
      kind: "toolCall",
      contentIndex: 0,
      toolCall: {
        id: "call-1",
        name: "bash",
        input: { command: "ls", timeout: 1000 },
      },
    });
  });

  it("preserves assistant usage, cost, stop, and error fields on turn completion", () => {
    const message = {
      ...assistant([{ type: "text", text: "Done" }]),
      stopReason: "error",
      errorMessage: "provider unavailable",
    };
    const event = decodePrimeAgentDaemonEvent(
      sessionEvent({ type: "turn_end", message, toolResults: [] }),
    );

    expect(event).toMatchObject({
      _tag: "TurnCompleted",
      message: {
        text: "Done",
        stopReason: "error",
        errorMessage: "provider unavailable",
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          cachedInputTokens: 3,
          cacheWriteTokens: 2,
          totalTokens: 24,
          totalCostUsd: 0.0033,
        },
      },
    });
  });

  it("maps message lifecycle for user, assistant, and tool-result messages", () => {
    expect(
      decodePrimeAgentDaemonEvent(
        sessionEvent({
          type: "message_start",
          message: { role: "user", content: "Please inspect this", timestamp: 10 },
        }),
      ),
    ).toMatchObject({
      _tag: "MessageStarted",
      message: { role: "user", text: "Please inspect this" },
    });

    expect(
      decodePrimeAgentDaemonEvent(
        sessionEvent({
          type: "message_end",
          message: assistant([{ type: "text", text: "I will" }]),
        }),
      ),
    ).toMatchObject({ _tag: "MessageCompleted", message: { role: "assistant", text: "I will" } });

    expect(
      decodePrimeAgentDaemonEvent(
        sessionEvent({
          type: "message_end",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "ok" }],
            details: { private: "not retained" },
            isError: false,
            timestamp: 11,
          },
        }),
      ),
    ).toEqual({
      _tag: "MessageCompleted",
      message: {
        role: "toolResult",
        timestamp: 11,
        toolCallId: "call-1",
        toolName: "bash",
        text: "ok",
        imageMimeTypes: [],
        isError: false,
      },
    });
  });

  it("maps tool execution start, accumulated progress, and completion", () => {
    expect(
      decodePrimeAgentDaemonEvent(
        sessionEvent({
          type: "tool_execution_start",
          toolCallId: "call-abc",
          toolName: "bash",
          args: { command: "ls -la" },
        }),
      ),
    ).toEqual({
      _tag: "ToolStarted",
      toolCallId: "call-abc",
      toolName: "bash",
      input: { command: "ls -la" },
    });

    expect(
      decodePrimeAgentDaemonEvent(
        sessionEvent({
          type: "tool_execution_update",
          toolCallId: "call-abc",
          toolName: "bash",
          args: { command: "ls -la" },
          partialResult: {
            content: [{ type: "text", text: "partial output" }],
            details: { fullOutputPath: null },
          },
        }),
      ),
    ).toMatchObject({ _tag: "ToolProgress", text: "partial output" });

    expect(
      decodePrimeAgentDaemonEvent(
        sessionEvent({
          type: "tool_execution_end",
          toolCallId: "call-abc",
          toolName: "bash",
          result: { content: [{ type: "text", text: "complete" }], details: {} },
          isError: false,
        }),
      ),
    ).toMatchObject({ _tag: "ToolCompleted", text: "complete", isError: false });
  });

  it("maps child, queue, goal, recap, and model-setting updates", () => {
    expect(
      decodePrimeAgentDaemonEvent(sessionEvent({ type: "rlm_child_update", child })),
    ).toMatchObject({
      _tag: "ChildUpdated",
      child: { id: "child-1", status: "running", activity: { toolName: "ipython" } },
    });
    expect(
      decodePrimeAgentDaemonEvent(sessionEvent({ type: "session_action_update", actions })),
    ).toMatchObject({ _tag: "QueueChanged", queuedCount: 2, followUps: ["Summarize"] });
    expect(decodePrimeAgentDaemonEvent(sessionEvent({ type: "goal_update", goal }))).toMatchObject({
      _tag: "GoalUpdated",
      goal: { objective: "Finish the integration" },
    });
    expect(
      decodePrimeAgentDaemonEvent(sessionEvent({ type: "recap_update", recap: "Working" })),
    ).toEqual({ _tag: "RecapUpdated", recap: "Working" });
    expect(
      decodePrimeAgentDaemonEvent(sessionEvent({ type: "thinking_level_changed", level: "xhigh" })),
    ).toEqual({ _tag: "ThinkingLevelChanged", level: "xhigh" });
    expect(
      decodePrimeAgentDaemonEvent(
        sessionEvent({ type: "service_tier_changed", serviceTier: "priority" }),
      ),
    ).toEqual({ _tag: "ServiceTierChanged", serviceTier: "priority" });
  });

  it("maps compaction, retry, bash, auth, and refinement status events", () => {
    const cases = [
      [
        { type: "compaction_start", reason: "threshold" },
        { _tag: "CompactionStarted", reason: "threshold" },
      ],
      [
        {
          type: "compaction_end",
          reason: "threshold",
          result: { summary: "Summary", firstKeptEntryId: "entry-1", tokensBefore: 150000 },
          aborted: false,
          willRetry: false,
        },
        { _tag: "CompactionCompleted", summary: "Summary", tokensBefore: 150000 },
      ],
      [
        {
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 2000,
          errorMessage: "overloaded",
        },
        { _tag: "RetryStarted", attempt: 1 },
      ],
      [
        { type: "auto_retry_end", success: true, attempt: 2 },
        { _tag: "RetryCompleted", success: true },
      ],
      [
        { type: "bash_start", command: "git status", excludeFromContext: true, runId: "run-1" },
        { _tag: "BashStarted", command: "git status" },
      ],
      [
        { type: "bash_output", chunk: "clean" },
        { _tag: "BashOutput", chunk: "clean" },
      ],
      [
        { type: "bash_end", exitCode: 0, cancelled: false, truncated: false, runId: "run-1" },
        { _tag: "BashCompleted", exitCode: 0 },
      ],
      [
        { type: "auth_stale", provider: "anthropic", sourceTokens: [{ source: "oauth" }] },
        { _tag: "AuthStale", provider: "anthropic", sourceCount: 1 },
      ],
      [
        {
          type: "refine_complete",
          result: {
            id: "ref-1",
            summary: "Added memory",
            rationale: "Repeated issue",
            expectedOutcome: "Fewer retries",
            appliedEdits: [
              { action: "create", kind: "memory", id: "mem-1", applied: true },
              { action: "update", kind: "skill", id: "skill-1", applied: false, error: "missing" },
            ],
            harnessStatePath: "/tmp/harness.json",
            scope: "local",
          },
        },
        { _tag: "RefinementCompleted", appliedCount: 1, failedCount: 1 },
      ],
      [{ type: "refine_failed", error: "invalid proposal" }, { _tag: "RefinementFailed" }],
    ] as const;

    for (const [input, expected] of cases) {
      expect(decodePrimeAgentDaemonEvent(sessionEvent(input))).toMatchObject(expected);
    }
  });

  it("maps extension dialogs without retaining unknown payload data", () => {
    const event = decodePrimeAgentDaemonEvent({
      type: "extension_ui_request",
      request: {
        id: "dialog-1",
        method: "select",
        payload: {
          title: "Allow dangerous command?",
          options: ["Allow", "Block"],
          timeout: 10_000,
          privateContext: { token: "secret" },
        },
      },
    });

    expect(event).toEqual({
      _tag: "ExtensionRequest",
      request: {
        id: "dialog-1",
        method: "select",
        title: "Allow dangerous command?",
        options: ["Allow", "Block"],
        timeoutMs: 10_000,
      },
    });
    expect(JSON.stringify(event)).not.toContain("secret");
  });

  it("maps resync, replacement, side questions, connection, heartbeat, and close events", () => {
    expect(
      decodePrimeAgentDaemonEvent({
        type: "session_resynced",
        snapshot: {
          state,
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
          streamingMessage: assistant([{ type: "text", text: "Hi" }]),
          children: [child],
          lastEventSequence: 42,
        },
      }),
    ).toMatchObject({
      _tag: "SessionResynced",
      state: { sessionId: "session-1" },
      messages: [{ role: "user", text: "Hello" }],
      children: [{ id: "child-1" }],
      lastEventSequence: 42,
    });
    expect(
      decodePrimeAgentDaemonEvent({ type: "session_replaced", state, messages: [] }),
    ).toMatchObject({ _tag: "SessionReplaced", state: { sessionName: "daemon-events" } });
    expect(
      decodePrimeAgentDaemonEvent({
        type: "side_question_event",
        event: { id: "q-1", question: "Why?", answer: "Because", status: "complete" },
      }),
    ).toMatchObject({ _tag: "SideQuestionUpdated", status: "complete" });
    expect(
      decodePrimeAgentDaemonEvent({
        type: "connection_status",
        status: "reconnecting",
        error: "lost",
      }),
    ).toEqual({ _tag: "ConnectionStatus", status: "reconnecting", error: "lost" });
    expect(decodePrimeAgentDaemonEvent({ type: "heartbeats_changed" })).toEqual({
      _tag: "HeartbeatsChanged",
    });
    expect(decodePrimeAgentDaemonEvent({ type: "closed", error: "daemon exited" })).toEqual({
      _tag: "SessionClosed",
      error: "daemon exited",
    });
  });

  it("turns unknown future and malformed known events into explicit ignored events", () => {
    expect(
      decodePrimeAgentDaemonEvent({
        type: "session_event",
        event: { type: "telepathy_delta", content: "future" },
      }),
    ).toEqual({
      _tag: "Ignored",
      reason: "unknown-event",
      sourceType: "session_event/telepathy_delta",
    });

    expect(
      decodePrimeAgentDaemonEvent(
        sessionEvent({
          type: "message_update",
          message: { role: "assistant", content: "not-an-array" },
          assistantMessageEvent: { type: "text_delta", contentIndex: "zero", delta: 12 },
        }),
      ),
    ).toEqual({
      _tag: "Ignored",
      reason: "malformed-event",
      sourceType: "session_event/message_update",
    });

    expect(decodePrimeAgentDaemonEvent(null)).toEqual({
      _tag: "Ignored",
      reason: "unknown-event",
      sourceType: undefined,
    });
  });
});
