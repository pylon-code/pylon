// @ts-ignore -- Vitest is provided by the vite-plus test runner.
import { describe, expect, it } from "vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  canOpenQuickQuestion,
  QUICK_QUESTION_LABEL,
  QUICK_QUESTION_TEST_ID,
  quickQuestionOpenScopeAfterAvailability,
  quickQuestionSessionScopeKey,
} from "./quickQuestionToolbar";

const provider = {
  featureCapabilities: {
    version: 1,
    automation: {
      support: "read-write",
      operations: ["side-questions"],
    },
  },
} as const;

const readySession = {
  threadId: ThreadId.make("thread"),
  status: "ready",
  providerName: "provider",
  providerInstanceId: ProviderInstanceId.make("provider-instance"),
  runtimeMode: "approval-required",
  startedAt: "2026-01-01T00:00:00.000Z",
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

describe("Quick question mobile toolbar", () => {
  it("uses stable public labels and test identity", () => {
    expect(QUICK_QUESTION_LABEL).toBe("Quick question");
    expect(QUICK_QUESTION_TEST_ID).toBe("quick-question-trigger");
  });

  it("gates on a connected fresh approval-required side-question session", () => {
    expect(
      canOpenQuickQuestion({ connectionState: "connected", session: readySession, provider }),
    ).toBe(true);

    const unavailableCases = [
      { connectionState: "offline", session: readySession, provider },
      {
        connectionState: "connected",
        session: { ...readySession, runtimeMode: "full-access" },
        provider,
      },
      {
        connectionState: "connected",
        session: { ...readySession, restored: true },
        provider,
      },
      {
        connectionState: "connected",
        session: { ...readySession, status: "starting" },
        provider,
      },
      {
        connectionState: "connected",
        session: readySession,
        provider: {
          featureCapabilities: {
            version: 1,
            automation: { support: "read-write", operations: ["heartbeats"] },
          },
        },
      },
      {
        connectionState: "connected",
        session: readySession,
        provider: {
          featureCapabilities: {
            version: 1,
            automation: { support: "read-only", operations: ["side-questions"] },
          },
        },
      },
      { connectionState: "connected", session: readySession, provider: null },
    ] as const satisfies ReadonlyArray<Parameters<typeof canOpenQuickQuestion>[0]>;

    for (const input of unavailableCases) {
      expect(canOpenQuickQuestion(input)).toBe(false);
    }
  });

  it("dismisses on availability loss without reopening when the same scope returns", () => {
    const openScope = "environment:thread:session";
    const dismissed = quickQuestionOpenScopeAfterAvailability(openScope, false);

    expect(dismissed).toBeNull();
    expect(quickQuestionOpenScopeAfterAvailability(dismissed, true)).toBeNull();
  });

  it("changes scope with thread, environment, provider, and session identity", () => {
    const base = {
      environmentId: "environment",
      threadId: "thread",
      providerInstanceId: "provider",
      sessionStartedAt: "2026-01-01T00:00:00.000Z",
    } as const;
    const scope = quickQuestionSessionScopeKey(base);
    expect(quickQuestionSessionScopeKey({ ...base, environmentId: "other" })).not.toBe(scope);
    expect(quickQuestionSessionScopeKey({ ...base, threadId: "other" })).not.toBe(scope);
    expect(quickQuestionSessionScopeKey({ ...base, providerInstanceId: "other" })).not.toBe(scope);
    expect(
      quickQuestionSessionScopeKey({
        ...base,
        sessionStartedAt: "2026-01-01T00:00:01.000Z",
      }),
    ).not.toBe(scope);
  });
});
