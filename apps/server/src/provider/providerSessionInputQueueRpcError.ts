import { ProviderSessionInputQueueError } from "@t3tools/contracts";

type ProviderInputQueueRpcError = {
  readonly _tag: string;
  readonly reason?: string | undefined;
};

export function toProviderSessionInputQueueError(
  error: ProviderInputQueueRpcError,
): ProviderSessionInputQueueError {
  const reason =
    error._tag === "ProviderUnsupportedError" ||
    error._tag === "ProviderAdapterUnsupportedOperationError"
      ? "unsupported"
      : error._tag === "ProviderAdapterSessionNotFoundError" ||
          error._tag === "ProviderAdapterSessionClosedError" ||
          error._tag === "ProviderSessionNotFoundError"
        ? "session-not-ready"
        : error._tag === "ProviderValidationError" ||
            error._tag === "ProviderAdapterValidationError"
          ? error.reason === "invalid-input"
            ? "invalid-input"
            : "session-not-ready"
          : "request-failed";
  return new ProviderSessionInputQueueError({ reason });
}
