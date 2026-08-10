import { ProviderSessionSideQuestionRequestId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeSessionSideQuestionOwnership } from "./sessionSideQuestionOwnership.ts";

const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");
const requestId = ProviderSessionSideQuestionRequestId.make("request-1");
const otherRequestId = ProviderSessionSideQuestionRequestId.make("request-2");

describe("session side-question ownership", () => {
  it("isolates cancellation ownership between WebSocket registries", () => {
    const ownerConnection = makeSessionSideQuestionOwnership();
    const otherConnection = makeSessionSideQuestionOwnership();
    const cancel = vi.fn(() => "cancel-requested" as const);
    const alreadySettled = vi.fn(() => "already-settled" as const);

    ownerConnection.register(threadId, requestId);

    expect(ownerConnection.owns(threadId, requestId)).toBe(true);
    expect(otherConnection.owns(threadId, requestId)).toBe(false);
    expect(
      otherConnection.match(threadId, requestId, {
        owned: cancel,
        unowned: alreadySettled,
      }),
    ).toBe("already-settled");
    expect(cancel).not.toHaveBeenCalled();
    expect(alreadySettled).toHaveBeenCalledOnce();
    expect(
      ownerConnection.match(threadId, requestId, {
        owned: cancel,
        unowned: alreadySettled,
      }),
    ).toBe("cancel-requested");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps ownership until every duplicate registration is removed", () => {
    const ownership = makeSessionSideQuestionOwnership();

    ownership.register(threadId, requestId);
    ownership.register(threadId, requestId);
    ownership.unregister(threadId, requestId);
    expect(ownership.owns(threadId, requestId)).toBe(true);

    ownership.unregister(threadId, requestId);
    expect(ownership.owns(threadId, requestId)).toBe(false);

    ownership.unregister(threadId, requestId);
    expect(ownership.owns(threadId, requestId)).toBe(false);
  });

  it("separates ownership by both thread and public request id", () => {
    const ownership = makeSessionSideQuestionOwnership();
    ownership.register(threadId, requestId);

    expect(ownership.owns(threadId, requestId)).toBe(true);
    expect(ownership.owns(threadId, otherRequestId)).toBe(false);
    expect(ownership.owns(otherThreadId, requestId)).toBe(false);
  });

  it("stores no prompt or answer content in its public state", () => {
    const ownership = makeSessionSideQuestionOwnership();
    const privateQuestion = "question-content-must-stay-out";
    const privateAnswer = "answer-content-must-stay-out";

    ownership.register(threadId, requestId);

    expect(Object.keys(ownership).sort()).toEqual(["match", "owns", "register", "unregister"]);
    const exposedState = Object.values(ownership).map(String).join("\n");
    expect(exposedState).not.toContain(privateQuestion);
    expect(exposedState).not.toContain(privateAnswer);
    expect(ownership.owns(threadId, requestId)).toBe(true);
  });
});
