// @ts-ignore -- Vitest is provided by the vite-plus test runner.
import { describe, expect, it } from "vitest";
import { ProviderSessionSideQuestionRequestId } from "@t3tools/contracts";

import {
  beginQuickQuestion,
  initialQuickQuestionState,
  resetQuickQuestion,
  settleQuickQuestion,
  updateQuickQuestionDraft,
} from "./quickQuestionState";

const requestId = ProviderSessionSideQuestionRequestId.make("request-1");

describe("Quick question component state", () => {
  it("transitions from submit to pending to a bounded temporary answer", () => {
    const draft = updateQuickQuestionDraft(initialQuickQuestionState("scope"), "  Why?  ");
    const pending = beginQuickQuestion(draft, requestId);
    expect(pending).toMatchObject({
      phase: "pending",
      draft: "  Why?  ",
      pendingRequestId: requestId,
    });

    const answered = settleQuickQuestion(pending, requestId, {
      requestId,
      disposition: "answered",
      answer: "Because.",
    });
    expect(answered).toMatchObject({
      phase: "answer",
      answer: "Because.",
      pendingRequestId: null,
      statusText: null,
    });
  });

  it("requests cancellation exactly once and ignores a late answer", () => {
    const pending = beginQuickQuestion(
      updateQuickQuestionDraft(initialQuickQuestionState("scope"), "Why?"),
      requestId,
    );
    const firstReset = resetQuickQuestion(pending);
    expect(firstReset.cancelRequestId).toBe(requestId);

    const secondReset = resetQuickQuestion(firstReset.state);
    expect(secondReset.cancelRequestId).toBeNull();
    expect(
      settleQuickQuestion(secondReset.state, requestId, {
        requestId,
        disposition: "answered",
        answer: "Late answer",
      }),
    ).toBe(secondReset.state);
  });

  it("uses a generic failure and never copies an untrusted mismatched payload", () => {
    const pending = beginQuickQuestion(
      updateQuickQuestionDraft(initialQuickQuestionState("scope"), "Why?"),
      requestId,
    );
    const otherRequestId = ProviderSessionSideQuestionRequestId.make("other-request");
    const failed = settleQuickQuestion(pending, requestId, {
      requestId: otherRequestId,
      disposition: "answered",
      answer: "raw native provider payload",
    });

    expect(failed).toMatchObject({
      phase: "draft",
      answer: "",
      statusText: "The side question could not be completed.",
    });
    expect(JSON.stringify(failed)).not.toContain("raw native provider payload");
  });

  it("clears question, answer, and pending identity when scope changes", () => {
    const pending = beginQuickQuestion(
      updateQuickQuestionDraft(initialQuickQuestionState("old-scope"), "Why?"),
      requestId,
    );
    const reset = resetQuickQuestion(pending, "new-scope");

    expect(reset.cancelRequestId).toBe(requestId);
    expect(reset.state).toEqual(initialQuickQuestionState("new-scope"));
  });
});
