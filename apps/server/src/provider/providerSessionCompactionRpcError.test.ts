import { describe, expect, it } from "vite-plus/test";

import { toProviderSessionCompactionError } from "./providerSessionCompactionRpcError.ts";

describe("provider session compaction RPC errors", () => {
  it("preserves provider-neutral busy, unsupported, and not-ready states", () => {
    expect(
      toProviderSessionCompactionError({
        _tag: "ProviderAdapterValidationError",
        reason: "busy",
      }).reason,
    ).toBe("busy");
    expect(
      toProviderSessionCompactionError({
        _tag: "ProviderAdapterUnsupportedOperationError",
      }).reason,
    ).toBe("unsupported");
    expect(
      toProviderSessionCompactionError({
        _tag: "ProviderAdapterSessionClosedError",
      }).reason,
    ).toBe("session-not-ready");
  });

  it("keeps ambiguous native failures generic", () => {
    expect(toProviderSessionCompactionError({ _tag: "ProviderAdapterRequestError" }).reason).toBe(
      "request-failed",
    );
  });
});
