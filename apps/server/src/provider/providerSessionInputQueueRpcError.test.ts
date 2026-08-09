import { describe, expect, it } from "vite-plus/test";

import { toProviderSessionInputQueueError } from "./providerSessionInputQueueRpcError.ts";

describe("provider session input queue RPC errors", () => {
  it("reports reconnecting adapter validation as session-not-ready", () => {
    expect(
      toProviderSessionInputQueueError({
        _tag: "ProviderAdapterValidationError",
        reason: "busy",
      }).reason,
    ).toBe("session-not-ready");
  });

  it("preserves invalid input and unsupported capability distinctions", () => {
    expect(
      toProviderSessionInputQueueError({
        _tag: "ProviderAdapterValidationError",
        reason: "invalid-input",
      }).reason,
    ).toBe("invalid-input");
    expect(
      toProviderSessionInputQueueError({
        _tag: "ProviderAdapterUnsupportedOperationError",
      }).reason,
    ).toBe("unsupported");
  });

  it("keeps ambiguous native failures generic", () => {
    expect(toProviderSessionInputQueueError({ _tag: "ProviderAdapterRequestError" }).reason).toBe(
      "request-failed",
    );
  });
});
