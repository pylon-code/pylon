// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to focused tests.
import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_BYTES,
  PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_CHARS,
  PROVIDER_SESSION_SIDE_QUESTION_MAX_CHARS,
  PROVIDER_SESSION_SIDE_QUESTION_REQUEST_ID_MAX_CHARS,
  ProviderAskSessionSideQuestionError,
  ProviderAskSessionSideQuestionInput,
  ProviderAskSessionSideQuestionResult,
  ProviderCancelSessionSideQuestionError,
  ProviderCancelSessionSideQuestionInput,
  ProviderCancelSessionSideQuestionResult,
} from "./provider.ts";
import { WS_METHODS } from "./rpc.ts";

const decodeAsk = Schema.decodeUnknownSync(ProviderAskSessionSideQuestionInput);
const decodeAskResult = Schema.decodeUnknownSync(ProviderAskSessionSideQuestionResult);
const decodeCancel = Schema.decodeUnknownSync(ProviderCancelSessionSideQuestionInput);
const decodeCancelResult = Schema.decodeUnknownSync(ProviderCancelSessionSideQuestionResult);
const decodeAskError = Schema.decodeUnknownSync(ProviderAskSessionSideQuestionError);
const decodeCancelError = Schema.decodeUnknownSync(ProviderCancelSessionSideQuestionError);

const request = { threadId: "thread-1", requestId: "question-1" };
const resultRequest = { requestId: request.requestId };

describe("session side-question contracts", () => {
  it("trims public ids and questions while accepting the exact Unicode/byte question bound", () => {
    expect(
      decodeAsk({
        threadId: "thread-1",
        requestId: "  question-1  ",
        question: "  What changed?  ",
      }),
    ).toEqual({ ...request, question: "What changed?" });

    const unicodeBoundary = "😀".repeat(PROVIDER_SESSION_SIDE_QUESTION_MAX_CHARS);
    expect(new TextEncoder().encode(unicodeBoundary).byteLength).toBe(16_384);
    expect(decodeAsk({ ...request, question: unicodeBoundary }).question).toBe(unicodeBoundary);
  });

  it("rejects empty, oversized, NUL-bearing, and oversized public-id questions", () => {
    expect(() => decodeAsk({ ...request, question: "   " })).toThrow();
    expect(() =>
      decodeAsk({
        ...request,
        question: "😀".repeat(PROVIDER_SESSION_SIDE_QUESTION_MAX_CHARS + 1),
      }),
    ).toThrow();
    expect(() => decodeAsk({ ...request, question: "before\0after" })).toThrow();
    expect(() =>
      decodeAsk({
        ...request,
        requestId: "r".repeat(PROVIDER_SESSION_SIDE_QUESTION_REQUEST_ID_MAX_CHARS + 1),
        question: "Question",
      }),
    ).toThrow();
  });

  it("requires bounded, NUL-free answer text only for answered results", () => {
    expect(
      decodeAskResult({ ...resultRequest, disposition: "answered", answer: "Answer" }),
    ).toEqual({ requestId: request.requestId, disposition: "answered", answer: "Answer" });
    expect(() => decodeAskResult({ ...resultRequest, disposition: "answered" })).toThrow();
    expect(() =>
      decodeAskResult({ ...resultRequest, disposition: "answered", answer: "before\0after" }),
    ).toThrow();

    const byteOversize = "😀".repeat(
      Math.floor(PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_BYTES / 4) + 1,
    );
    expect([...byteOversize].length).toBeLessThan(PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_CHARS);
    expect(new TextEncoder().encode(byteOversize).byteLength).toBeGreaterThan(
      PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_BYTES,
    );
    expect(() =>
      decodeAskResult({ ...resultRequest, disposition: "answered", answer: byteOversize }),
    ).toThrow();
    expect(() =>
      decodeAskResult({
        ...resultRequest,
        disposition: "answered",
        answer: "a".repeat(PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_CHARS + 1),
      }),
    ).toThrow();
  });

  it("decodes every sanitized terminal and cancellation disposition", () => {
    for (const disposition of [
      "cancelled",
      "timed-out",
      "response-too-large",
      "outcome-unknown",
    ] as const) {
      expect(decodeAskResult({ ...resultRequest, disposition })).toEqual({
        requestId: request.requestId,
        disposition,
      });
    }
    expect(decodeCancel({ threadId: request.threadId, requestId: request.requestId })).toEqual(
      request,
    );
    expect(
      decodeCancelResult({ requestId: request.requestId, disposition: "cancel-requested" }),
    ).toEqual({ requestId: request.requestId, disposition: "cancel-requested" });
    expect(
      decodeCancelResult({ requestId: request.requestId, disposition: "already-settled" }),
    ).toEqual({ requestId: request.requestId, disposition: "already-settled" });
  });

  it("keeps typed failures to the public reason vocabulary", () => {
    for (const reason of ["session-not-ready", "unsupported", "busy", "request-failed"] as const) {
      expect(decodeAskError({ _tag: "ProviderAskSessionSideQuestionError", reason }).reason).toBe(
        reason,
      );
      expect(
        decodeCancelError({ _tag: "ProviderCancelSessionSideQuestionError", reason }).reason,
      ).toBe(reason);
    }
    expect(() =>
      decodeAskError({ _tag: "ProviderAskSessionSideQuestionError", reason: "native-error" }),
    ).toThrow();
  });

  it("registers both unary provider RPC method names", () => {
    expect(WS_METHODS.providerAskSessionSideQuestion).toBe("provider.askSessionSideQuestion");
    expect(WS_METHODS.providerCancelSessionSideQuestion).toBe("provider.cancelSessionSideQuestion");
  });
});
