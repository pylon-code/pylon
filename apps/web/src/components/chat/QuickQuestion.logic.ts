import type { ProviderAskSessionSideQuestionResult } from "@t3tools/contracts";

import {
  PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_BYTES,
  PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_CHARS,
  PROVIDER_SESSION_SIDE_QUESTION_MAX_BYTES,
  PROVIDER_SESSION_SIDE_QUESTION_MAX_CHARS,
} from "@t3tools/contracts";

export type QuickQuestionView =
  | { readonly status: "prompt"; readonly question: string }
  | { readonly status: "pending" }
  | { readonly status: "cancelling" }
  | { readonly status: "answer"; readonly answer: string }
  | {
      readonly status: "result";
      readonly disposition:
        | "cancelled"
        | "cancel-requested"
        | "timed-out"
        | "response-too-large"
        | "outcome-unknown"
        | "already-settled";
    }
  | { readonly status: "error" };

export type QuickQuestionEvent =
  | { readonly type: "edit"; readonly question: string }
  | { readonly type: "submit" }
  | { readonly type: "resolved"; readonly result: ProviderAskSessionSideQuestionResult }
  | { readonly type: "failed" }
  | { readonly type: "cancel" }
  | { readonly type: "cancelled"; readonly alreadySettled: boolean }
  | { readonly type: "reset" };

export const initialQuickQuestionView: QuickQuestionView = { status: "prompt", question: "" };

export function reduceQuickQuestionView(
  state: QuickQuestionView,
  event: QuickQuestionEvent,
): QuickQuestionView {
  switch (event.type) {
    case "edit":
      return state.status === "prompt"
        ? { status: "prompt", question: fitQuickQuestionText(event.question) }
        : state;
    case "submit":
      return state.status === "prompt" && quickQuestionCanSubmit(state.question)
        ? { status: "pending" }
        : state;
    case "resolved":
      if (state.status !== "pending") return state;
      return event.result.disposition === "answered"
        ? { status: "answer", answer: fitQuickQuestionAnswer(event.result.answer) }
        : { status: "result", disposition: event.result.disposition };
    case "failed":
      return state.status === "pending" || state.status === "cancelling"
        ? { status: "error" }
        : state;
    case "cancel":
      return state.status === "pending" ? { status: "cancelling" } : state;
    case "cancelled":
      return state.status === "cancelling"
        ? {
            status: "result",
            disposition: event.alreadySettled ? "already-settled" : "cancel-requested",
          }
        : state;
    case "reset":
      return initialQuickQuestionView;
  }
}

function fitUtf8(value: string, maxCodePoints: number, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = "";
  let codePoints = 0;
  let bytes = 0;
  for (const codePoint of value) {
    if (codePoint === "\0") continue;
    const nextBytes = encoder.encode(codePoint).byteLength;
    if (codePoints === maxCodePoints || bytes + nextBytes > maxBytes) break;
    result += codePoint;
    codePoints += 1;
    bytes += nextBytes;
  }
  return result;
}

export function fitQuickQuestionText(value: string): string {
  return fitUtf8(
    value,
    PROVIDER_SESSION_SIDE_QUESTION_MAX_CHARS,
    PROVIDER_SESSION_SIDE_QUESTION_MAX_BYTES,
  );
}

export function fitQuickQuestionAnswer(value: string): string {
  return fitUtf8(
    value,
    PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_CHARS,
    PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_BYTES,
  );
}

export function quickQuestionCanSubmit(question: string): boolean {
  return question.trim().length > 0 && question === fitQuickQuestionText(question);
}

export function quickQuestionResultMessage(
  disposition: Extract<QuickQuestionView, { status: "result" }>["disposition"],
): string {
  switch (disposition) {
    case "cancelled":
      return "The quick question was cancelled. No answer was added to the thread.";
    case "cancel-requested":
      return "Cancellation requested. No answer will be added to the thread.";
    case "timed-out":
      return "The quick question timed out. Its outcome is unknown, so Pylon will not retry it.";
    case "response-too-large":
      return "The answer was too long to display.";
    case "outcome-unknown":
      return "The quick question outcome is unknown. Pylon will not retry it.";
    case "already-settled":
      return "The quick question had already finished, but its answer is no longer available.";
  }
}
