import { describe, expect, it } from "vite-plus/test";

import { toProviderMessageSessionAgentError } from "./providerMessageSessionAgentRpcError.ts";

describe("provider session agent message RPC errors", () => {
  it("maps safe admission states without native detail", () => {
    expect(
      toProviderMessageSessionAgentError({ _tag: "ProviderAdapterValidationError" }).reason,
    ).toBe("agent-not-active");
    expect(
      toProviderMessageSessionAgentError({
        _tag: "ProviderValidationError",
        operation: "ProviderService.messageSessionAgent",
        reason: "invalid-input",
      }).reason,
    ).toBe("invalid-message");
    expect(
      toProviderMessageSessionAgentError({
        _tag: "ProviderAdapterRequestError",
        method: "session/message-agent-invalid-message",
      }).reason,
    ).toBe("invalid-message");
    expect(
      toProviderMessageSessionAgentError({
        _tag: "ProviderAdapterRequestError",
        method: "session/message-agent-not-ready",
      }).reason,
    ).toBe("agent-not-messageable");
    expect(
      toProviderMessageSessionAgentError({ _tag: "ProviderAdapterUnsupportedOperationError" })
        .reason,
    ).toBe("unsupported");
  });

  it("distinguishes post-invocation uncertainty from known preflight failure", () => {
    expect(
      toProviderMessageSessionAgentError({
        _tag: "ProviderAdapterRequestError",
        method: "session/message-agent-delivery-unknown",
      }).reason,
    ).toBe("delivery-unknown");
    expect(
      toProviderMessageSessionAgentError({
        _tag: "ProviderAdapterRequestError",
        method: "session/get-agent-roster",
      }).reason,
    ).toBe("request-failed");
  });
});
