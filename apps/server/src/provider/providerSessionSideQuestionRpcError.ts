import {
  ProviderAskSessionSideQuestionError,
  ProviderCancelSessionSideQuestionError,
} from "@t3tools/contracts";

import type { ProviderServiceError } from "./Errors.ts";

type SideQuestionErrorReason = ProviderAskSessionSideQuestionError["reason"];

function sideQuestionErrorReason(error: ProviderServiceError): SideQuestionErrorReason {
  switch (error._tag) {
    case "ProviderUnsupportedError":
    case "ProviderAdapterUnsupportedOperationError":
      return "unsupported";
    case "ProviderAdapterSessionNotFoundError":
    case "ProviderAdapterSessionClosedError":
    case "ProviderSessionNotFoundError":
    case "ProviderInstanceNotFoundError":
    case "ProviderValidationError":
      return "session-not-ready";
    case "ProviderAdapterValidationError":
      return error.reason === "busy" ? "busy" : "request-failed";
    default:
      return "request-failed";
  }
}

export function toProviderAskSessionSideQuestionError(
  error: ProviderServiceError,
): ProviderAskSessionSideQuestionError {
  return new ProviderAskSessionSideQuestionError({ reason: sideQuestionErrorReason(error) });
}

export function toProviderCancelSessionSideQuestionError(
  error: ProviderServiceError,
): ProviderCancelSessionSideQuestionError {
  return new ProviderCancelSessionSideQuestionError({ reason: sideQuestionErrorReason(error) });
}
