import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  PROVIDER_SESSION_GOAL_OBJECTIVE_MAX_CHARS,
  ProviderRuntimeEvent,
  SessionGoalUpdatedPayload,
} from "./providerRuntime.ts";

const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodePayload = Schema.decodeUnknownSync(SessionGoalUpdatedPayload);

describe("session.goal.updated", () => {
  it("decodes only provider-neutral read-only goal state", () => {
    const decoded = decodeEvent({
      type: "session.goal.updated",
      eventId: "evt-goal",
      provider: "primeAgent",
      providerInstanceId: "prime-work",
      threadId: "thread-1",
      createdAt: "2026-08-09T00:00:00.000Z",
      payload: {
        available: true,
        active: true,
        status: "paused",
        objective: "  Finish the integration  ",
        tokenBudget: 10_000,
        tokensUsed: 2_500,
        timeUsedSeconds: 42,
        continuationsUsed: 1,
        goalId: "native-private-id",
        createdAt: 123,
        lastReason: "private reason",
        lastError: "/Users/private/project",
      },
    });

    expect(decoded.type).toBe("session.goal.updated");
    if (decoded.type !== "session.goal.updated") return;
    expect(decoded.payload).toEqual({
      available: true,
      active: true,
      status: "paused",
      objective: "Finish the integration",
      tokenBudget: 10_000,
      tokensUsed: 2_500,
      timeUsedSeconds: 42,
      continuationsUsed: 1,
    });
    expect(JSON.stringify(decoded)).not.toContain("native-private-id");
    expect(JSON.stringify(decoded)).not.toContain("private reason");
    expect(JSON.stringify(decoded)).not.toContain("/Users/");
    expect(() =>
      decodeEvent({
        ...decoded,
        providerRefs: { providerRequestId: "native-request" },
      }),
    ).toThrow();
    expect(() =>
      decodeEvent({
        ...decoded,
        raw: { sessionFile: "/Users/private/session.jsonl" },
      }),
    ).toThrow();
  });

  it("bounds the objective by Unicode characters and rejects malformed counters", () => {
    expect(
      decodePayload({
        available: true,
        active: true,
        status: "active",
        objective: "🧭".repeat(PROVIDER_SESSION_GOAL_OBJECTIVE_MAX_CHARS),
        tokensUsed: 0,
        timeUsedSeconds: 0,
        continuationsUsed: 0,
      }).objective,
    ).toHaveLength(PROVIDER_SESSION_GOAL_OBJECTIVE_MAX_CHARS * 2);
    expect(() =>
      decodePayload({
        available: true,
        active: true,
        status: "active",
        objective: "x".repeat(PROVIDER_SESSION_GOAL_OBJECTIVE_MAX_CHARS + 1),
        tokensUsed: 0,
        timeUsedSeconds: 0,
        continuationsUsed: 0,
      }),
    ).toThrow();
    expect(() =>
      decodePayload({
        available: true,
        active: false,
        status: "idle",
        tokensUsed: -1,
        timeUsedSeconds: 0,
        continuationsUsed: 0,
      }),
    ).toThrow();
  });
});
