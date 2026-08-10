import { describe, expect, it } from "vite-plus/test";

import { toProviderRefineSessionHarnessError } from "./providerRefineSessionHarnessRpcError.ts";

describe("provider local harness refinement RPC errors", () => {
  it("preserves only provider-neutral eligibility states", () => {
    expect(
      toProviderRefineSessionHarnessError({
        _tag: "ProviderAdapterValidationError",
        reason: "busy",
      }).reason,
    ).toBe("busy");
    expect(
      toProviderRefineSessionHarnessError({
        _tag: "ProviderAdapterUnsupportedOperationError",
      }).reason,
    ).toBe("unsupported");
    expect(
      toProviderRefineSessionHarnessError({
        _tag: "ProviderAdapterSessionClosedError",
      }).reason,
    ).toBe("session-not-ready");
  });

  it("keeps ambiguous native failures generic", () => {
    expect(
      toProviderRefineSessionHarnessError({
        _tag: "ProviderAdapterRequestError",
        reason: "/private/native/path",
      }).reason,
    ).toBe("request-failed");
  });
});
