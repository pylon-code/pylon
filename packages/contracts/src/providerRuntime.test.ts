import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EventId, RuntimeItemId, ThreadId, TurnId } from "./baseSchemas.ts";
import { classifyTaskAgentKind, ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const encodeRuntimeEvent = Schema.encodeSync(ProviderRuntimeEvent);
const eventId = Schema.decodeUnknownSync(EventId)("event-stream-correction");
const threadId = Schema.decodeUnknownSync(ThreadId)("thread-stream-correction");
const turnId = Schema.decodeUnknownSync(TurnId)("turn-stream-correction");
const itemId = Schema.decodeUnknownSync(RuntimeItemId)("item-stream-correction");

describe("ProviderRuntimeEvent", () => {
  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("round-trips canonical interaction and presentation events", () => {
    const events = [
      {
        type: "interaction.requested",
        eventId: "event-interaction-requested",
        provider: "primeAgent",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "thread-3",
        requestId: "interaction-1",
        payload: {
          request: {
            kind: "select",
            title: "Choose a client",
            options: ["web", "desktop"],
            timeout: 10_000,
          },
        },
      },
      {
        type: "interaction.resolved",
        eventId: "event-interaction-resolved",
        provider: "primeAgent",
        createdAt: "2026-02-28T00:00:04.000Z",
        threadId: "thread-3",
        requestId: "interaction-1",
        payload: {
          response: { kind: "selected", value: "desktop" },
        },
      },
      {
        type: "session-presentation.updated",
        eventId: "event-presentation-updated",
        provider: "primeAgent",
        createdAt: "2026-02-28T00:00:05.000Z",
        threadId: "thread-3",
        payload: {
          presentation: {
            kind: "widget",
            key: "plan",
            lines: ["1. Add contracts", "2. Add adapters"],
          },
        },
      },
    ];

    for (const event of events) {
      expect(encodeRuntimeEvent(decodeRuntimeEvent(event))).toEqual(event);
    }
  });

  it("requires a bounded request id on interaction lifecycle events", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "interaction.requested",
        eventId: "event-interaction-no-id",
        provider: "primeAgent",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "thread-3",
        payload: {
          request: { kind: "input", title: "Input" },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeRuntimeEvent({
        type: "interaction.resolved",
        eventId: "event-interaction-long-id",
        provider: "primeAgent",
        createdAt: "2026-02-28T00:00:04.000Z",
        threadId: "thread-3",
        requestId: "r".repeat(129),
        payload: { response: { kind: "cancelled" } },
      }),
    ).toThrow();
  });

  it("accepts prime-agent.daemon raw sources for local server diagnostics", () => {
    const parsed = decodeRuntimeEvent({
      type: "runtime.warning",
      eventId: "event-daemon-warning",
      provider: "primeAgent",
      createdAt: "2026-02-28T00:00:06.000Z",
      threadId: "thread-3",
      payload: { message: "Daemon reconnected" },
      raw: {
        source: "prime-agent.daemon",
        method: "connection_status",
        payload: { connected: true },
      },
    });

    expect(parsed.raw?.source).toBe("prime-agent.daemon");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });

  it("decodes typed context usage clear barriers", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.cleared",
      eventId: "event-token-usage-clear-1",
      provider: "primeAgent",
      createdAt: "2026-02-28T00:00:05.000Z",
      threadId: "thread-1",
      payload: { reason: "unknown" },
    });

    expect(parsed).toMatchObject({
      type: "thread.token-usage.cleared",
      payload: { reason: "unknown" },
    });
    expect(() =>
      decodeRuntimeEvent({
        type: "thread.token-usage.cleared",
        eventId: "event-token-usage-clear-2",
        provider: "primeAgent",
        createdAt: "2026-02-28T00:00:05.000Z",
        threadId: "thread-1",
        payload: { reason: "native-private-reason" },
      }),
    ).toThrow();
  });

  it("round-trips provider-neutral stream correction events", () => {
    const events = [
      {
        type: "content.replaced",
        eventId,
        provider: "primeAgent",
        createdAt: "2026-08-11T00:00:00.000Z",
        threadId,
        turnId,
        itemId,
        payload: {
          streamKind: "assistant_text",
          text: "authoritative replacement",
        },
      },
      {
        type: "content.replaced",
        eventId,
        provider: "primeAgent",
        createdAt: "2026-08-11T00:00:00.000Z",
        threadId,
        turnId,
        itemId,
        payload: {
          streamKind: "assistant_text",
          text: "",
        },
      },
      {
        type: "turn.output-reset",
        eventId,
        provider: "primeAgent",
        createdAt: "2026-08-11T00:00:00.000Z",
        threadId,
        turnId,
        payload: {
          reason: "provider_retry",
          attempt: 2,
          max: 3,
        },
      },
    ];

    for (const event of events) {
      expect(encodeRuntimeEvent(decodeRuntimeEvent(event))).toEqual(event);
    }
  });

  it("rejects malformed provider-neutral stream correction events", () => {
    const replacementEvent = {
      type: "content.replaced",
      eventId,
      provider: "primeAgent",
      createdAt: "2026-08-11T00:00:00.000Z",
      threadId,
      turnId,
      itemId,
      payload: {
        streamKind: "assistant_text",
        text: "authoritative replacement",
      },
    };
    const resetEvent = {
      type: "turn.output-reset",
      eventId,
      provider: "primeAgent",
      createdAt: "2026-08-11T00:00:00.000Z",
      threadId,
      turnId,
      payload: {
        reason: "provider_retry",
        attempt: 2,
        max: 3,
      },
    };

    const { turnId: _turnId, ...replacementWithoutTurnId } = replacementEvent;
    expect(() => decodeRuntimeEvent(replacementWithoutTurnId)).toThrow();
    expect(() =>
      decodeRuntimeEvent({
        ...replacementEvent,
        payload: { ...replacementEvent.payload, text: 42 },
      }),
    ).toThrow();
    expect(() =>
      decodeRuntimeEvent({
        ...resetEvent,
        payload: { ...resetEvent.payload, attempt: 0 },
      }),
    ).toThrow();
    expect(() =>
      decodeRuntimeEvent({
        ...resetEvent,
        payload: { ...resetEvent.payload, max: 0 },
      }),
    ).toThrow();
    expect(() =>
      decodeRuntimeEvent({
        ...resetEvent,
        payload: { ...resetEvent.payload, attempt: 4 },
      }),
    ).toThrow();
  });
});

describe("classifyTaskAgentKind", () => {
  it("classifies agent-flavored, watch-loop, and inert types", () => {
    expect(classifyTaskAgentKind({ taskType: "local_agent" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_workflow" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: undefined })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "brand_new_agent_type" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_bash" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "monitor" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "plan" })).toBe("background");
  });

  it("agent-owned tasks are background unless themselves agent-flavored", () => {
    expect(classifyTaskAgentKind({ taskType: "local_bash", agentId: "owner" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: undefined, agentId: "owner" })).toBe("background");
    // Nested agent: outlives its parent, stays in the roster.
    expect(classifyTaskAgentKind({ taskType: "local_agent", agentId: "owner" })).toBe("agent");
  });
});
