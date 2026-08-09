import { ProviderSessionCompactionError } from "@t3tools/contracts";

type ProviderCompactionRpcError = {
  readonly _tag: string;
  readonly reason?: string | undefined;
};

export function toProviderSessionCompactionError(
  error: ProviderCompactionRpcError,
): ProviderSessionCompactionError {
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
          ? error.reason === "busy"
            ? "busy"
            : "session-not-ready"
          : "request-failed";
  return new ProviderSessionCompactionError({ reason });
}
