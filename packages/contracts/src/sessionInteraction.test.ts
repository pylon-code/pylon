import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  SESSION_INTERACTION_CONTENT_MAX_CHARS,
  SESSION_INTERACTION_KEY_MAX_CHARS,
  SESSION_INTERACTION_OPTION_MAX_CHARS,
  SESSION_INTERACTION_OPTIONS_MAX_ITEMS,
  SESSION_INTERACTION_REQUEST_ID_MAX_CHARS,
  SESSION_INTERACTION_TIMEOUT_MAX_MS,
  SESSION_INTERACTION_TITLE_MAX_CHARS,
  SESSION_INTERACTION_WIDGET_LINES_MAX_ITEMS,
  SessionInteractionRequest,
  SessionInteractionRequestId,
  SessionInteractionResponse,
  SessionPresentation,
} from "./sessionInteraction.ts";

const decodeRequest = Schema.decodeUnknownSync(SessionInteractionRequest);
const encodeRequest = Schema.encodeSync(SessionInteractionRequest);
const decodeResponse = Schema.decodeUnknownSync(SessionInteractionResponse);
const encodeResponse = Schema.encodeSync(SessionInteractionResponse);
const decodePresentation = Schema.decodeUnknownSync(SessionPresentation);
const encodePresentation = Schema.encodeSync(SessionPresentation);
const decodeRequestId = Schema.decodeUnknownSync(SessionInteractionRequestId);

describe("SessionInteractionRequest", () => {
  it("round-trips every blocking request variant", () => {
    const requests = [
      {
        kind: "select",
        title: "Choose a target",
        options: ["web", "desktop"],
        timeout: 5_000,
      },
      {
        kind: "confirm",
        title: "Continue?",
        message: "This may modify files.",
        timeout: 0,
      },
      {
        kind: "input",
        title: "Branch name",
        placeholder: "feature/session-ui",
      },
      {
        kind: "editor",
        title: "Edit the plan",
        prefill: "# Plan\n",
        timeout: SESSION_INTERACTION_TIMEOUT_MAX_MS,
      },
    ];

    for (const request of requests) {
      expect(encodeRequest(decodeRequest(request))).toEqual(request);
    }
  });

  it("keeps optional confirm copy, input/editor hints, and widget placement absent", () => {
    expect(encodeRequest(decodeRequest({ kind: "confirm", title: "Confirm" }))).toEqual({
      kind: "confirm",
      title: "Confirm",
    });
    expect(encodeRequest(decodeRequest({ kind: "input", title: "Input" }))).toEqual({
      kind: "input",
      title: "Input",
    });
    expect(encodeRequest(decodeRequest({ kind: "editor", title: "Editor" }))).toEqual({
      kind: "editor",
      title: "Editor",
    });
  });

  it("rejects discriminator/field mismatches", () => {
    expect(() =>
      decodeRequest({
        kind: "confirm",
        options: ["yes", "no"],
      }),
    ).toThrow();
    expect(() => decodeRequest({ kind: "select", title: "Choose", options: [] })).toThrow();
    expect(() => decodeRequest({ kind: "select", title: "Choose", options: ["   "] })).toThrow();
  });

  it("enforces request id, content, collection, and timeout bounds", () => {
    expect(decodeRequestId("r".repeat(SESSION_INTERACTION_REQUEST_ID_MAX_CHARS))).toBeTruthy();
    expect(() =>
      decodeRequestId("r".repeat(SESSION_INTERACTION_REQUEST_ID_MAX_CHARS + 1)),
    ).toThrow();
    expect(() =>
      decodeRequest({
        kind: "confirm",
        title: "t".repeat(SESSION_INTERACTION_TITLE_MAX_CHARS + 1),
        message: "message",
      }),
    ).toThrow();
    expect(() =>
      decodeRequest({
        kind: "confirm",
        title: "Confirm",
        message: "m".repeat(SESSION_INTERACTION_CONTENT_MAX_CHARS + 1),
      }),
    ).toThrow();
    expect(() =>
      decodeRequest({
        kind: "select",
        title: "Select",
        options: ["o".repeat(SESSION_INTERACTION_OPTION_MAX_CHARS + 1)],
      }),
    ).toThrow();
    expect(() =>
      decodeRequest({
        kind: "select",
        title: "Select",
        options: Array.from({ length: SESSION_INTERACTION_OPTIONS_MAX_ITEMS + 1 }, () => "x"),
      }),
    ).toThrow();
    expect(() => decodeRequest({ kind: "input", title: "Input", timeout: -1 })).toThrow();
    expect(() =>
      decodeRequest({
        kind: "editor",
        title: "Editor",
        timeout: SESSION_INTERACTION_TIMEOUT_MAX_MS + 1,
      }),
    ).toThrow();
  });
});

describe("SessionInteractionResponse", () => {
  it("round-trips every method-compatible response variant", () => {
    const responses = [
      { kind: "selected", value: "desktop" },
      { kind: "confirmed", confirmed: false },
      { kind: "submitted", value: "edited text" },
      { kind: "cancelled" },
    ];

    for (const response of responses) {
      expect(encodeResponse(decodeResponse(response))).toEqual(response);
    }
  });

  it("rejects mismatched and oversized responses", () => {
    expect(() => decodeResponse({ kind: "selected", confirmed: true })).toThrow();
    expect(() =>
      decodeResponse({
        kind: "submitted",
        value: "x".repeat(SESSION_INTERACTION_CONTENT_MAX_CHARS + 1),
      }),
    ).toThrow();
  });
});

describe("SessionPresentation", () => {
  it("round-trips every nonblocking presentation variant", () => {
    const presentations = [
      { kind: "notification", message: "Saved", level: "info" },
      { kind: "status", key: "build", text: "Running" },
      {
        kind: "widget",
        key: "plan",
        lines: ["Plan", "1. Test"],
        placement: "belowEditor",
      },
    ];

    for (const presentation of presentations) {
      expect(encodePresentation(decodePresentation(presentation))).toEqual(presentation);
    }
  });

  it("represents status and widget clears by omitting content", () => {
    expect(encodePresentation(decodePresentation({ kind: "status", key: "build" }))).toEqual({
      kind: "status",
      key: "build",
    });
    expect(encodePresentation(decodePresentation({ kind: "widget", key: "plan" }))).toEqual({
      kind: "widget",
      key: "plan",
    });
  });

  it("enforces key and widget line bounds", () => {
    expect(() =>
      decodePresentation({
        kind: "status",
        key: "k".repeat(SESSION_INTERACTION_KEY_MAX_CHARS + 1),
      }),
    ).toThrow();
    expect(() =>
      decodePresentation({
        kind: "widget",
        key: "plan",
        lines: ["x".repeat(SESSION_INTERACTION_OPTION_MAX_CHARS + 1)],
      }),
    ).toThrow();
    expect(() =>
      decodePresentation({
        kind: "widget",
        key: "plan",
        lines: Array.from({ length: SESSION_INTERACTION_WIDGET_LINES_MAX_ITEMS + 1 }, () => "line"),
      }),
    ).toThrow();
  });

  it("drops unknown fields from decoded variants", () => {
    expect(
      encodePresentation(
        decodePresentation({
          kind: "notification",
          message: "Saved",
          level: "info",
          futureAction: { label: "Undo" },
        }),
      ),
    ).toEqual({ kind: "notification", message: "Saved", level: "info" });
  });
});
