import {
  ApprovalRequestId,
  EventId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { foldUserInputActivities, getQuestionAnswerPreview } from "./userInput.ts";

const turnId = TurnId.make("turn-1");
const createdAt = "2026-09-01T00:00:00.000Z";
function activity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return { id: EventId.make(id), kind, payload, turnId, createdAt, tone: "tool", summary: kind };
}

describe("foldUserInputActivities", () => {
  it("keeps the original question position and selected option labels", () => {
    const request = activity("requested", "user-input.requested", {
      requestId: "request-1",
      questions: [
        { id: "target", question: "Where?", options: [{ value: "local", label: "This computer" }] },
      ],
    });
    const resolved = activity("resolved", "user-input.resolved", { requestId: "request-1" });
    const submitted = activity("submitted", "user-input.answer-submitted", {
      requestId: "request-1",
      questionTextById: { target: "Where?" },
      answers: { target: ["local"] },
    });
    const folded = foldUserInputActivities([request, resolved, submitted]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      id: request.id,
      createdAt,
      kind: "user-input.answer-submitted",
      payload: {
        requestId: "request-1",
        questionTextById: { target: "Where?" },
        answers: { target: ["This computer"] },
        attachmentsByQuestionId: {},
      },
    });
    expect(
      getQuestionAnswerPreview({
        requestId: ApprovalRequestId.make("request-1"),
        questionTextById: { target: "Where?" },
        answers: { target: ["This computer"] },
        attachmentsByQuestionId: {},
      }),
    ).toBe("This computer");
  });

  it("folds the corresponding native tool but retains failed tool results and other turns", () => {
    const answer = activity("answer", "user-input.answer-submitted", {
      requestId: "request-1",
      questionTextById: { q: "Where?" },
      answers: { q: "Local" },
      attachmentsByQuestionId: {},
    });
    const tool = activity("tool", "tool.completed", {
      toolCallId: "call-1",
      title: "request_user_input",
      data: { input: { questions: [{ question: "Where?" }] } },
    });
    const failed = { ...tool, id: EventId.make("failed"), tone: "error" as const };
    const otherTurn = { ...tool, id: EventId.make("other-turn"), turnId: TurnId.make("turn-2") };
    expect(
      foldUserInputActivities([tool, failed, otherTurn, answer]).map((entry) => entry.id),
    ).toEqual([failed.id, otherTurn.id, answer.id]);
  });

  it("keeps malformed input and distinguishes pending from dismissed requests", () => {
    const malformed = activity("malformed", "user-input.requested", { questions: [] });
    const request = activity("request", "user-input.requested", {
      requestId: "request-1",
      questions: [{ id: "q", question: "Where?" }],
    });
    expect(foldUserInputActivities([malformed])[0]).toBe(malformed);
    expect(foldUserInputActivities([request])[0]?.summary).toBe("User input requested");
    expect(
      foldUserInputActivities([
        request,
        activity("resolved", "user-input.resolved", { requestId: "request-1" }),
      ])[0]?.summary,
    ).toBe("User input dismissed");
  });
});
