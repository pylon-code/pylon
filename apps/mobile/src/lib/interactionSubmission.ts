import type { SessionInteractionRequestId, SessionInteractionResponse } from "@t3tools/contracts";

import type { SessionInteractionFailure } from "./sessionInteractions";

export interface InteractionSubmissionState {
  readonly requestId: SessionInteractionRequestId;
  readonly response: SessionInteractionResponse;
  readonly phase: "submitting" | "error";
  readonly error: string | null;
  readonly failureIdAtStart: string | null;
}

export interface InteractionSubmissionView {
  readonly submitting: boolean;
  readonly error: string | null;
  readonly canRetry: boolean;
}

export function deriveInteractionSubmissionView(
  state: InteractionSubmissionState | null,
  activeRequestId: SessionInteractionRequestId | null,
  activeFailure: SessionInteractionFailure | null,
): InteractionSubmissionView {
  const isActive =
    state !== null && activeRequestId !== null && state.requestId === activeRequestId;
  return {
    submitting: isActive && state.phase === "submitting",
    error: isActive ? state.error : (activeFailure?.message ?? null),
    canRetry: isActive && state.phase === "error",
  };
}

export function beginInteractionSubmission(
  requestId: SessionInteractionRequestId,
  response: SessionInteractionResponse,
  failureIdAtStart: string | null,
): InteractionSubmissionState {
  return { requestId, response, phase: "submitting", error: null, failureIdAtStart };
}

/** Command success is acceptance only; the provider reactor still owns resolution. */
export function interactionCommandAccepted(
  state: InteractionSubmissionState,
): InteractionSubmissionState {
  return state;
}

export function interactionCommandFailed(
  state: InteractionSubmissionState,
  error: string,
): InteractionSubmissionState {
  return { ...state, phase: "error", error };
}

export function reconcileInteractionSubmission(
  state: InteractionSubmissionState,
  activeRequestId: SessionInteractionRequestId | null,
  activeFailure: SessionInteractionFailure | null,
): InteractionSubmissionState | null {
  if (state.requestId !== activeRequestId) {
    return null;
  }
  if (
    state.phase === "submitting" &&
    activeFailure !== null &&
    activeFailure.id !== state.failureIdAtStart
  ) {
    return interactionCommandFailed(state, activeFailure.message);
  }
  return state;
}

export interface InteractionSubmissionLock {
  current: SessionInteractionRequestId | null;
}

/** A synchronous tap guard; React state does not update until the next render. */
export function acquireInteractionSubmissionLock(
  lock: InteractionSubmissionLock,
  requestId: SessionInteractionRequestId,
): boolean {
  if (lock.current !== null) {
    return false;
  }
  lock.current = requestId;
  return true;
}

export function releaseInteractionSubmissionLock(
  lock: InteractionSubmissionLock,
  requestId: SessionInteractionRequestId,
): void {
  if (lock.current === requestId) {
    lock.current = null;
  }
}
