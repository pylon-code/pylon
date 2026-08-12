import { describe, expect, it } from "@effect/vitest";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "./Errors.ts";
import { toProviderRespondToInteractionError } from "./providerInteractionResponseRpcError.ts";

describe("toProviderRespondToInteractionError", () => {
  it("preserves typed stale and unsupported request reasons", () => {
    for (const reason of ["stale", "unsupported"] as const) {
      const mapped = toProviderRespondToInteractionError(
        new ProviderAdapterRequestError({
          provider: "primeAgent",
          method: "session/interaction-response",
          detail: "safe detail",
          reason,
        }),
      );
      expect(mapped.reason).toBe(reason);
    }
  });

  it("maps validation and missing sessions without exposing provider detail", () => {
    const stale = toProviderRespondToInteractionError(
      new ProviderAdapterValidationError({
        provider: "primeAgent",
        operation: "respondToInteraction",
        issue: "sensitive issue",
      }),
    );
    const missing = toProviderRespondToInteractionError(
      new ProviderAdapterSessionNotFoundError({ provider: "primeAgent", threadId: "thread-1" }),
    );
    expect(stale).toMatchObject({ _tag: "ProviderRespondToInteractionError", reason: "stale" });
    expect(missing).toMatchObject({
      _tag: "ProviderRespondToInteractionError",
      reason: "session-not-ready",
    });
    expect(JSON.stringify([stale, missing])).not.toContain("sensitive issue");
  });

  it("fails closed for unclassified request failures", () => {
    const mapped = toProviderRespondToInteractionError(
      new ProviderAdapterRequestError({
        provider: "primeAgent",
        method: "session/interaction-response",
        detail: "native secret marker",
      }),
    );
    expect(mapped.reason).toBe("request-failed");
    expect(JSON.stringify(mapped)).not.toContain("native secret marker");
  });
});
