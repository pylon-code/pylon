import { describe, expect, it } from "vite-plus/test";

import { SessionInteractionRequestId } from "@t3tools/contracts";

import {
  acquireInteractionSubmissionLock,
  beginInteractionSubmission,
  deriveInteractionSubmissionView,
  interactionCommandAccepted,
  reconcileInteractionSubmission,
  releaseInteractionSubmissionLock,
} from "./interactionSubmission";

const requestId = SessionInteractionRequestId.make("opaque-1");

describe("interaction submission lifecycle", () => {
  it("renders an idle thread without dereferencing a missing submission", () => {
    expect(deriveInteractionSubmissionView(null, null, null)).toEqual({
      submitting: false,
      error: null,
      canRetry: false,
    });
  });

  it("synchronously rejects a same-tick duplicate response", () => {
    const lock: { current: typeof requestId | null } = { current: null };
    expect(acquireInteractionSubmissionLock(lock, requestId)).toBe(true);
    expect(acquireInteractionSubmissionLock(lock, requestId)).toBe(false);
    releaseInteractionSubmissionLock(lock, requestId);
    expect(acquireInteractionSubmissionLock(lock, requestId)).toBe(true);
  });

  it("keeps controls submitting after command acceptance until the event stream resolves", () => {
    const submitting = beginInteractionSubmission(
      requestId,
      { kind: "confirmed", confirmed: true },
      null,
    );
    const accepted = interactionCommandAccepted(submitting);

    expect(accepted.phase).toBe("submitting");
    expect(reconcileInteractionSubmission(accepted, requestId, null)).toBe(accepted);
    expect(reconcileInteractionSubmission(accepted, null, null)).toBeNull();
  });

  it("turns a later matching provider failure into a retryable error", () => {
    const submitting = beginInteractionSubmission(
      requestId,
      { kind: "selected", value: "Mobile" },
      "old-failure",
    );
    expect(
      reconcileInteractionSubmission(submitting, requestId, {
        id: "old-failure",
        requestId,
        message: "old",
      }),
    ).toBe(submitting);

    expect(
      reconcileInteractionSubmission(submitting, requestId, {
        id: "new-failure",
        requestId,
        message: "The session did not accept this response. Try again or cancel.",
      }),
    ).toMatchObject({ phase: "error", response: { kind: "selected", value: "Mobile" } });
  });
});
