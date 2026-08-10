import { ProviderRefineSessionHarnessError } from "@t3tools/contracts";

type ProviderRefinementRpcError = {
  readonly _tag: string;
  readonly reason?: string | undefined;
};

export function toProviderRefineSessionHarnessError(
  error: ProviderRefinementRpcError,
): ProviderRefineSessionHarnessError {
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
  return new ProviderRefineSessionHarnessError({ reason });
}
