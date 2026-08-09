import { ProviderMessageSessionAgentError } from "@t3tools/contracts";

type ProviderAgentMessageRpcError = {
  readonly _tag: string;
  readonly method?: string | undefined;
  readonly operation?: string | undefined;
  readonly reason?: string | undefined;
};

export function toProviderMessageSessionAgentError(
  error: ProviderAgentMessageRpcError,
): ProviderMessageSessionAgentError {
  const reason =
    error._tag === "ProviderUnsupportedError" ||
    error._tag === "ProviderAdapterUnsupportedOperationError"
      ? "unsupported"
      : (error._tag === "ProviderValidationError" &&
            error.operation === "ProviderService.messageSessionAgent" &&
            error.reason === "invalid-input") ||
          (error._tag === "ProviderAdapterRequestError" &&
            error.method === "session/message-agent-invalid-message")
        ? "invalid-message"
        : error._tag === "ProviderAdapterRequestError" &&
            error.method === "session/message-agent-delivery-unknown"
          ? "delivery-unknown"
          : error._tag === "ProviderAdapterRequestError" &&
              error.method === "session/message-agent-not-ready"
            ? "agent-not-messageable"
            : error._tag === "ProviderAdapterValidationError"
              ? "agent-not-active"
              : error._tag === "ProviderAdapterSessionNotFoundError" ||
                  error._tag === "ProviderAdapterSessionClosedError" ||
                  error._tag === "ProviderSessionNotFoundError" ||
                  error._tag === "ProviderValidationError"
                ? "session-not-ready"
                : "request-failed";
  return new ProviderMessageSessionAgentError({ reason });
}
