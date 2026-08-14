import { ProviderSessionSideQuestionRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to focused tests.
import { describe, expect, it } from "vitest";

import {
  fitQuickQuestionAnswer,
  fitQuickQuestionText,
  initialQuickQuestionView,
  quickQuestionResultMessage,
  reduceQuickQuestionView,
} from "./QuickQuestion.logic";
import { Dialog } from "../ui/dialog";
import { QuickQuestionDialogBody } from "./QuickQuestionDialog";

const requestId = ProviderSessionSideQuestionRequestId.make("pylon-request");
const noop = () => undefined;

function renderView(view: Parameters<typeof QuickQuestionDialogBody>[0]["view"]): string {
  return renderToStaticMarkup(
    <Dialog open>
      <QuickQuestionDialogBody
        view={view}
        onQuestionChange={noop}
        onSubmit={noop}
        onCancel={noop}
        onDismiss={noop}
      />
    </Dialog>,
  );
}

describe("Quick question", () => {
  it("renders the disclosure and stable prompt controls", () => {
    const markup = renderView(initialQuickQuestionView);
    expect(markup).toContain("Quick question");
    expect(markup).toContain('data-testid="quick-question-input"');
    expect(markup).toContain('data-testid="quick-question-submit"');
    expect(markup).toContain("answer is temporary, not added to the thread");
    expect(markup).toContain("approval-required sessions");
  });

  it("bounds prompt and answer by Unicode code points and UTF-8 bytes", () => {
    expect([...fitQuickQuestionText("a".repeat(5_000))]).toHaveLength(4_096);
    expect(new TextEncoder().encode(fitQuickQuestionText("😀".repeat(5_000))).byteLength).toBe(
      16_384,
    );
    expect(new TextEncoder().encode(fitQuickQuestionAnswer("😀".repeat(5_000))).byteLength).toBe(
      8_192,
    );
    expect(fitQuickQuestionText("before\0after")).toBe("beforeafter");
  });

  it("moves a successful request to a bounded temporary answer", () => {
    const edited = reduceQuickQuestionView(initialQuickQuestionView, {
      type: "edit",
      question: "What changed?",
    });
    const pending = reduceQuickQuestionView(edited, { type: "submit" });
    const answered = reduceQuickQuestionView(pending, {
      type: "resolved",
      result: { requestId, disposition: "answered", answer: "Only this answer." },
    });
    expect(answered).toEqual({ status: "answer", answer: "Only this answer." });

    const markup = renderView(answered);
    expect(markup).toContain('data-testid="quick-question-answer"');
    expect(markup).toContain("Only this answer.");
    expect(markup).toContain(">Copy<");
    expect(markup).toContain(">Dismiss<");
    expect(markup).not.toContain("pylon-request");
  });

  it("truthfully labels an empty completed answer", () => {
    const markup = renderView({ status: "answer", answer: "" });
    expect(markup).toContain("The session returned an empty answer.");
    expect(markup).toContain(">Copy<");
  });

  it("cancels once and ignores a late answer after cancellation", () => {
    const pending = { status: "pending" } as const;
    const cancelling = reduceQuickQuestionView(pending, { type: "cancel" });
    expect(cancelling).toEqual({ status: "cancelling" });
    expect(reduceQuickQuestionView(cancelling, { type: "cancel" })).toBe(cancelling);
    expect(
      reduceQuickQuestionView(cancelling, {
        type: "resolved",
        result: { requestId, disposition: "answered", answer: "late private answer" },
      }),
    ).toBe(cancelling);
    expect(renderView(cancelling)).toContain('data-testid="quick-question-cancel"');
  });

  it("resets local prompt and answer state on identity change", () => {
    const answer = { status: "answer", answer: "ephemeral" } as const;
    expect(reduceQuickQuestionView(answer, { type: "reset" })).toEqual(initialQuickQuestionView);
  });

  it("uses generic terminal labels and never leaks raw transport failures", () => {
    const errorMarkup = renderView({ status: "error" });
    expect(errorMarkup).toContain("could not be completed");
    expect(errorMarkup).toContain("will not retry");
    expect(errorMarkup).not.toContain("native-secret-stack");
    expect(quickQuestionResultMessage("cancelled")).toContain("was cancelled");
    expect(quickQuestionResultMessage("cancel-requested")).toContain("Cancellation requested");
    expect(quickQuestionResultMessage("timed-out")).toContain("timed out");
    expect(quickQuestionResultMessage("response-too-large")).toContain("too long");
    expect(quickQuestionResultMessage("outcome-unknown")).toContain("will not retry");
  });
});
