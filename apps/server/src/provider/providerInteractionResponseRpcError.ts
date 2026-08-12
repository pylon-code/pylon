import { ProviderRespondToInteractionError } from "@t3tools/contracts";

import type { ProviderServiceError } from "./Errors.ts";

export function toProviderRespondToInteractionError(
  error: ProviderServiceError,
): ProviderRespondToInteractionError {
  const reason = (() => {
    switch (error._tag) {
      case "ProviderUnsupportedError":
      case "ProviderAdapterUnsupportedOperationError":
        return "unsupported" as const;
      case "ProviderAdapterRequestError":
        return error.reason ?? "request-failed";
      case "ProviderAdapterValidationError":
        return "stale" as const;
      case "ProviderAdapterSessionNotFoundError":
      case "ProviderAdapterSessionClosedError":
      case "ProviderSessionNotFoundError":
      case "ProviderInstanceNotFoundError":
      case "ProviderValidationError":
        return "session-not-ready" as const;
      default:
        return "request-failed" as const;
    }
  })();
  return new ProviderRespondToInteractionError({ reason });
}
