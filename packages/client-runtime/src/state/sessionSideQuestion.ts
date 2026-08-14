import type {
  OrchestrationSession,
  ProviderAskSessionSideQuestionResult,
  ProviderCancelSessionSideQuestionResult,
  ServerProvider,
} from "@t3tools/contracts";

import type { SupervisorConnectionPhase } from "../connection/model.ts";

/** Provider-neutral capability gate for one-shot session side questions. */
export function supportsSessionSideQuestions(
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
): boolean {
  const automation = provider?.featureCapabilities?.automation;
  return automation?.support === "read-write" && automation.operations.includes("side-questions");
}

/**
 * Side questions are live-only and device-scoped. A disconnected, stopped,
 * full-access, or restored session must never expose the command.
 */
export function canAskSessionSideQuestion(
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
  connectionPhase: SupervisorConnectionPhase,
  session: Pick<OrchestrationSession, "runtimeMode" | "status" | "restored"> | null | undefined,
): boolean {
  return (
    connectionPhase === "connected" &&
    session?.runtimeMode === "approval-required" &&
    session.restored !== true &&
    (session.status === "ready" || session.status === "running") &&
    supportsSessionSideQuestions(provider)
  );
}

export type SessionSideQuestionFailureReason =
  | "session-not-ready"
  | "unsupported"
  | "busy"
  | "request-failed";

export function sessionSideQuestionFailureReason(
  error: unknown,
): SessionSideQuestionFailureReason | null {
  if (typeof error !== "object" || error === null || !("reason" in error)) return null;
  const reason = error.reason;
  return reason === "session-not-ready" ||
    reason === "unsupported" ||
    reason === "busy" ||
    reason === "request-failed"
    ? reason
    : null;
}

/** Safe presentation text that never includes provider/native error details. */
export function sessionSideQuestionErrorLabel(error: unknown): string {
  switch (sessionSideQuestionFailureReason(error)) {
    case "session-not-ready":
      return "The provider session is not ready for a side question.";
    case "unsupported":
      return "Side questions are unavailable for this session.";
    case "busy":
      return "Another side question is already in progress.";
    case "request-failed":
    default:
      return "The side question could not be completed.";
  }
}

/** Safe terminal label; the answer remains only in the command result. */
export function sessionSideQuestionResultLabel(
  result: ProviderAskSessionSideQuestionResult,
): string {
  switch (result.disposition) {
    case "answered":
      return "Side question answered.";
    case "cancelled":
      return "Side question cancelled.";
    case "timed-out":
      return "Side question timed out.";
    case "response-too-large":
      return "The side-question response was too large.";
    case "outcome-unknown":
      return "The side-question outcome is unknown.";
  }
}

export function sessionSideQuestionCancelResultLabel(
  result: ProviderCancelSessionSideQuestionResult,
): string {
  switch (result.disposition) {
    case "cancel-requested":
      return "Side-question cancellation requested.";
    case "already-settled":
      return "The side question has already settled.";
  }
}
