// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to focused tests.
import { describe, expect, it } from "vitest";
import type {
  OrchestrationSession,
  ProviderAskSessionSideQuestionResult,
  ProviderCancelSessionSideQuestionResult,
  ServerProvider,
} from "@t3tools/contracts";

import {
  canAskSessionSideQuestion,
  sessionSideQuestionCancelResultLabel,
  sessionSideQuestionErrorLabel,
  sessionSideQuestionFailureReason,
  sessionSideQuestionResultLabel,
  supportsSessionSideQuestions,
} from "./sessionSideQuestion.ts";

function provider(
  support: "unavailable" | "read-only" | "read-write",
  operations: ReadonlyArray<string>,
): Pick<ServerProvider, "featureCapabilities"> {
  return {
    featureCapabilities: {
      version: 1,
      automation: { support, operations },
    },
  } as Pick<ServerProvider, "featureCapabilities">;
}

const advertised = provider("read-write", ["side-questions"]);
const activeSession = {
  runtimeMode: "approval-required",
  status: "running",
  restored: false,
} satisfies Pick<OrchestrationSession, "runtimeMode" | "status" | "restored">;

type AskResultWithoutId<T = ProviderAskSessionSideQuestionResult> = T extends unknown
  ? Omit<T, "requestId">
  : never;

function askResult(result: AskResultWithoutId): ProviderAskSessionSideQuestionResult {
  return { requestId: "request-1" as ProviderAskSessionSideQuestionResult["requestId"], ...result };
}

function cancelResult(
  disposition: ProviderCancelSessionSideQuestionResult["disposition"],
): ProviderCancelSessionSideQuestionResult {
  return {
    requestId: "request-1" as ProviderCancelSessionSideQuestionResult["requestId"],
    disposition,
  };
}

describe("session side-question client helpers", () => {
  it("uses only the advertised automation write operation for support", () => {
    expect(supportsSessionSideQuestions(advertised)).toBe(true);
    expect(supportsSessionSideQuestions(provider("read-only", ["side-questions"]))).toBe(false);
    expect(supportsSessionSideQuestions(provider("unavailable", ["side-questions"]))).toBe(false);
    expect(supportsSessionSideQuestions(provider("read-write", ["heartbeats"]))).toBe(false);
    expect(supportsSessionSideQuestions(null)).toBe(false);
  });

  it("allows only connected, active, fresh approval-required sessions", () => {
    expect(canAskSessionSideQuestion(advertised, "connected", activeSession)).toBe(true);
    expect(
      canAskSessionSideQuestion(advertised, "connected", { ...activeSession, status: "ready" }),
    ).toBe(true);

    for (const connectionPhase of [
      "available",
      "offline",
      "connecting",
      "backoff",
      "blocked",
    ] as const) {
      expect(canAskSessionSideQuestion(advertised, connectionPhase, activeSession)).toBe(false);
    }
    for (const status of ["idle", "starting", "interrupted", "stopped", "error"] as const) {
      expect(canAskSessionSideQuestion(advertised, "connected", { ...activeSession, status })).toBe(
        false,
      );
    }
    expect(
      canAskSessionSideQuestion(advertised, "connected", {
        ...activeSession,
        runtimeMode: "full-access",
      }),
    ).toBe(false);
    expect(
      canAskSessionSideQuestion(advertised, "connected", {
        ...activeSession,
        runtimeMode: "auto",
      }),
    ).toBe(false);
    expect(
      canAskSessionSideQuestion(advertised, "connected", {
        ...activeSession,
        restored: true,
      }),
    ).toBe(false);
    expect(canAskSessionSideQuestion(provider("read-write", []), "connected", activeSession)).toBe(
      false,
    );
    expect(canAskSessionSideQuestion(advertised, "connected", null)).toBe(false);
  });

  it("returns safe public error labels without surfacing native details", () => {
    expect(sessionSideQuestionFailureReason({ reason: "busy" })).toBe("busy");
    expect(sessionSideQuestionFailureReason({ reason: "native-private-error" })).toBeNull();
    expect(sessionSideQuestionErrorLabel({ reason: "session-not-ready" })).toContain("not ready");
    expect(sessionSideQuestionErrorLabel({ reason: "unsupported" })).toContain("unavailable");
    expect(sessionSideQuestionErrorLabel({ reason: "busy" })).toContain("already in progress");
    expect(sessionSideQuestionErrorLabel({ reason: "request-failed" })).toContain(
      "could not be completed",
    );
    expect(sessionSideQuestionErrorLabel(new Error("/private/path: daemon failed"))).not.toContain(
      "/private/path",
    );
  });

  it("formats terminal dispositions without retaining or echoing the answer", () => {
    const secretAnswer = "answer that stays in the command result";
    const answered = sessionSideQuestionResultLabel(
      askResult({ disposition: "answered", answer: secretAnswer }),
    );
    expect(answered).toBe("Side question answered.");
    expect(answered).not.toContain(secretAnswer);
    expect(sessionSideQuestionResultLabel(askResult({ disposition: "cancelled" }))).toContain(
      "cancelled",
    );
    expect(sessionSideQuestionResultLabel(askResult({ disposition: "timed-out" }))).toContain(
      "timed out",
    );
    expect(
      sessionSideQuestionResultLabel(askResult({ disposition: "response-too-large" })),
    ).toContain("too large");
    expect(sessionSideQuestionResultLabel(askResult({ disposition: "outcome-unknown" }))).toContain(
      "unknown",
    );
    expect(sessionSideQuestionCancelResultLabel(cancelResult("cancel-requested"))).toContain(
      "requested",
    );
    expect(sessionSideQuestionCancelResultLabel(cancelResult("already-settled"))).toContain(
      "already settled",
    );
  });
});
