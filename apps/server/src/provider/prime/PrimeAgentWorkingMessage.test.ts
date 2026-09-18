import { describe, expect, it } from "@effect/vitest";

import { decodePrimeAgentDaemonEvent } from "./PrimeAgentDaemonEvents.ts";

describe("native Prime working-message updates", () => {
  const request = {
    id: "kernel-progress",
    method: "setWorkingMessage",
    attribution: { scope: "prompt", correlationId: "prompt-1" },
  };

  it.each([{ message: "Starting Python kernel..." }, {}, { message: "" }])(
    "accepts attributed progress and clear payloads: %j",
    (payload) => {
      const decoded = decodePrimeAgentDaemonEvent(
        { type: "extension_ui_request", request: { ...request, payload } },
        { correlatedPromptLifecycle: true },
      );
      expect(decoded).toMatchObject({
        _tag: "ExtensionRequest",
        attribution: request.attribution,
        request: {
          id: request.id,
          method: request.method,
        },
      });
    },
  );

  it("accepts session-scoped progress without assigning it to a prompt", () => {
    expect(
      decodePrimeAgentDaemonEvent(
        {
          type: "extension_ui_request",
          request: {
            ...request,
            attribution: { scope: "session" },
            payload: { message: "Restoring Python state..." },
          },
        },
        { correlatedPromptLifecycle: true },
      ),
    ).toMatchObject({
      _tag: "ExtensionRequest",
      attribution: { scope: "session" },
    });
  });

  it.each([
    { attribution: undefined, payload: { message: "Starting" } },
    { attribution: { scope: "prompt" }, payload: { message: "Starting" } },
    { payload: { message: 42 } },
    { method: "unrecognizedWorkingMethod", payload: { message: "Starting" } },
  ])("still rejects malformed or unattributed updates: %j", (override) => {
    expect(
      decodePrimeAgentDaemonEvent(
        { type: "extension_ui_request", request: { ...request, ...override } },
        { correlatedPromptLifecycle: true },
      ),
    ).toEqual({ _tag: "CorrelatedProtocolViolation" });
  });

  it("preserves stock compatibility when correlation was not negotiated", () => {
    expect(
      decodePrimeAgentDaemonEvent({
        type: "extension_ui_request",
        request: {
          id: "stock-progress",
          method: "setWorkingMessage",
          payload: { message: "Starting Python kernel..." },
        },
      }),
    ).toMatchObject({ _tag: "ExtensionRequest", request: { method: "setWorkingMessage" } });
  });
});
