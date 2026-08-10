import { describe, expect, it } from "vite-plus/test";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterUnsupportedOperationError,
  ProviderAdapterValidationError,
  ProviderUnsupportedError,
  ProviderValidationError,
} from "./Errors.ts";
import {
  toProviderAskSessionSideQuestionError,
  toProviderCancelSessionSideQuestionError,
} from "./providerSessionSideQuestionRpcError.ts";

describe("side-question websocket error mapping", () => {
  it("maps unsupported and inactive sessions to safe reasons", () => {
    expect(
      toProviderAskSessionSideQuestionError(new ProviderUnsupportedError({ provider: "codex" }))
        .reason,
    ).toBe("unsupported");
    expect(
      toProviderCancelSessionSideQuestionError(
        new ProviderAdapterUnsupportedOperationError({
          provider: "codex",
          operation: "cancelSessionSideQuestion",
        }),
      ).reason,
    ).toBe("unsupported");
    expect(
      toProviderAskSessionSideQuestionError(
        new ProviderValidationError({
          operation: "ProviderService.askSessionSideQuestion",
          issue: "No active session.",
        }),
      ).reason,
    ).toBe("session-not-ready");
    expect(
      toProviderCancelSessionSideQuestionError(
        new ProviderAdapterSessionClosedError({ provider: "codex", threadId: "thread-1" }),
      ).reason,
    ).toBe("session-not-ready");
  });

  it("exposes only adapter busy while collapsing other failures", () => {
    expect(
      toProviderAskSessionSideQuestionError(
        new ProviderAdapterValidationError({
          provider: "codex",
          operation: "askSessionSideQuestion",
          issue: "Another request is active.",
          reason: "busy",
        }),
      ).reason,
    ).toBe("busy");
    expect(
      toProviderAskSessionSideQuestionError(
        new ProviderAdapterValidationError({
          provider: "codex",
          operation: "askSessionSideQuestion",
          issue: "Rejected.",
          reason: "invalid-input",
        }),
      ).reason,
    ).toBe("request-failed");
    expect(
      toProviderCancelSessionSideQuestionError(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "cancelSessionSideQuestion",
          detail: "private provider failure",
        }),
      ).reason,
    ).toBe("request-failed");
  });
});
