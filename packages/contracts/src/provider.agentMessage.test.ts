import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS,
  ProviderMessageSessionAgentInput,
  ProviderMessageSessionAgentResult,
} from "./provider.ts";
import { ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeInput = Schema.decodeUnknownSync(ProviderMessageSessionAgentInput);
const decodeResult = Schema.decodeUnknownSync(ProviderMessageSessionAgentResult);
const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("provider session agent messaging", () => {
  it("trims bounded text and keeps only canonical selectors", () => {
    expect(
      decodeInput({
        threadId: "thread-1",
        agentId: "task-1",
        message: "  Check the failing test.  ",
        activeSessionId: "private-native-target",
      }),
    ).toEqual({
      threadId: "thread-1",
      agentId: "task-1",
      message: "Check the failing test.",
    });
  });

  it("rejects empty and oversized messages", () => {
    expect(() =>
      decodeInput({ threadId: "thread-1", agentId: "task-1", message: "   " }),
    ).toThrow();
    expect(() =>
      decodeInput({
        threadId: "thread-1",
        agentId: "task-1",
        message: "x".repeat(PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS + 1),
      }),
    ).toThrow();
  });

  it("projects only endpoint availability on agent lifecycle rows", () => {
    const decoded = decodeRuntimeEvent({
      type: "task.progress",
      eventId: "evt-agent",
      provider: "primeAgent",
      providerInstanceId: "prime-work",
      threadId: "thread-1",
      createdAt: "2026-08-09T00:00:00.000Z",
      payload: {
        taskId: "task-1",
        description: "Reviewer",
        status: "running",
        messageable: true,
        activeSessionId: "private-native-target",
        sessionPath: "/private/session.jsonl",
      },
    });
    expect(decoded.payload).toMatchObject({ messageable: true });
    expect(JSON.stringify(decoded)).not.toContain("activeSessionId");
    expect(JSON.stringify(decoded)).not.toContain("sessionPath");
    expect(JSON.stringify(decoded)).not.toContain("/private/");
  });

  it("drops native receipt identity, timestamps, and echoed content", () => {
    expect(
      decodeResult({
        agentId: "task-1",
        disposition: "queued",
        id: "agentmsg_private",
        target: { activeSessionId: "private-native-target" },
        message: "private content",
        queuedAt: "2026-08-09T00:00:00.000Z",
      }),
    ).toEqual({ agentId: "task-1", disposition: "queued" });
  });
});
