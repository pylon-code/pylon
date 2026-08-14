import {
  sessionSideQuestionErrorLabel,
  sessionSideQuestionResultLabel,
} from "@t3tools/client-runtime/state/session-side-question";
import type {
  ProviderAskSessionSideQuestionResult,
  ProviderSessionSideQuestionRequestId,
} from "@t3tools/contracts";

export interface QuickQuestionState {
  readonly scopeKey: string;
  readonly phase: "draft" | "pending" | "answer";
  readonly draft: string;
  readonly answer: string;
  readonly statusText: string | null;
  readonly pendingRequestId: ProviderSessionSideQuestionRequestId | null;
}

export interface QuickQuestionReset {
  readonly state: QuickQuestionState;
  readonly cancelRequestId: ProviderSessionSideQuestionRequestId | null;
}

export function initialQuickQuestionState(scopeKey: string): QuickQuestionState {
  return {
    scopeKey,
    phase: "draft",
    draft: "",
    answer: "",
    statusText: null,
    pendingRequestId: null,
  };
}

export function updateQuickQuestionDraft(
  state: QuickQuestionState,
  draft: string,
): QuickQuestionState {
  if (state.phase !== "draft") return state;
  return { ...state, draft, statusText: null };
}

export function beginQuickQuestion(
  state: QuickQuestionState,
  requestId: ProviderSessionSideQuestionRequestId,
): QuickQuestionState {
  if (state.phase !== "draft" || state.draft.trim().length === 0) return state;
  return {
    ...state,
    phase: "pending",
    answer: "",
    statusText: null,
    pendingRequestId: requestId,
  };
}

/** Ignores late, duplicate, and cross-scope results by public request identity. */
export function settleQuickQuestion(
  state: QuickQuestionState,
  requestId: ProviderSessionSideQuestionRequestId,
  result: ProviderAskSessionSideQuestionResult | null,
): QuickQuestionState {
  if (state.phase !== "pending" || state.pendingRequestId !== requestId) return state;
  if (result?.requestId !== requestId) {
    return {
      ...state,
      phase: "draft",
      statusText: sessionSideQuestionErrorLabel(null),
      pendingRequestId: null,
    };
  }
  if (result.disposition === "answered") {
    return {
      ...state,
      phase: "answer",
      answer: result.answer,
      statusText: null,
      pendingRequestId: null,
    };
  }
  return {
    ...state,
    phase: "draft",
    statusText: sessionSideQuestionResultLabel(result),
    pendingRequestId: null,
  };
}

/**
 * Clears all device-local content. Applying the reset state again returns no
 * cancellation effect, so close and unmount paths can safely converge.
 */
export function resetQuickQuestion(
  state: QuickQuestionState,
  scopeKey: string = state.scopeKey,
): QuickQuestionReset {
  return {
    state: initialQuickQuestionState(scopeKey),
    cancelRequestId: state.phase === "pending" ? state.pendingRequestId : null,
  };
}
