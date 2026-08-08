import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  SessionInteractionRequestId,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import {
  buildSessionInteractionCommandInput,
  compactSessionPresentationText,
  foldSessionInteractionActivities,
} from "./sessionInteractions";

const CREATED_AT = "2026-08-08T12:00:00.000Z";

function activity(
  id: string,
  kind: string,
  payload: unknown,
  sequence: number,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: "Session activity",
    payload,
    turnId: null,
    sequence,
    createdAt: CREATED_AT,
  };
}

function request(id: string, requestPayload: unknown, sequence: number) {
  return activity(
    `request-${sequence}`,
    "interaction.requested",
    { requestId: id, request: requestPayload },
    sequence,
  );
}

describe("foldSessionInteractionActivities", () => {
  it("strictly decodes and retains every provider-neutral request variant by opaque id", () => {
    const state = foldSessionInteractionActivities([
      request(
        "opaque/select:1",
        { kind: "select", title: "Target", options: ["Web", "Mobile"] },
        1,
      ),
      request("opaque-confirm", { kind: "confirm", title: "Continue?", message: "Ship it" }, 2),
      request("opaque-input", { kind: "input", title: "Name", placeholder: "Release name" }, 3),
      request("opaque-editor", { kind: "editor", title: "Notes", prefill: "Draft" }, 4),
      // Missing the required title, so the exported strict decoder rejects it.
      request("malformed", { kind: "input", placeholder: "Ignored" }, 5),
    ]);

    expect(state.pending.map(({ requestId, request: value }) => [requestId, value.kind])).toEqual([
      ["opaque/select:1", "select"],
      ["opaque-confirm", "confirm"],
      ["opaque-input", "input"],
      ["opaque-editor", "editor"],
    ]);
  });

  it("clears only the matching resolved or stale/unknown request", () => {
    const state = foldSessionInteractionActivities([
      request("resolved", { kind: "confirm", title: "Resolved" }, 1),
      request("stale", { kind: "input", title: "Stale" }, 2),
      request("still-open", { kind: "editor", title: "Open" }, 3),
      activity(
        "resolved-event",
        "interaction.resolved",
        { requestId: "resolved", response: { kind: "confirmed", confirmed: true } },
        4,
      ),
      activity(
        "stale-event",
        "provider.interaction.respond.failed",
        { requestId: "stale", detail: "Unknown pending interaction request: stale" },
        5,
      ),
      activity(
        "ordinary-failure",
        "provider.interaction.respond.failed",
        { requestId: "still-open", detail: "Connection failed" },
        6,
      ),
    ]);

    expect(state.pending.map(({ requestId }) => requestId)).toEqual(["still-open"]);
    expect(state.failures).toEqual([
      {
        id: "ordinary-failure",
        requestId: "still-open",
        message: "The session did not accept this response. Try again or cancel.",
      },
    ]);
  });

  it("does not let malformed resolutions or stale failures clear a request", () => {
    const state = foldSessionInteractionActivities([
      request("keep", { kind: "confirm", title: "Keep" }, 1),
      activity(
        "malformed-resolution",
        "interaction.resolved",
        { requestId: "keep", response: { kind: "confirmed", confirmed: "yes" } },
        2,
      ),
      activity(
        "malformed-stale",
        "provider.interaction.respond.failed",
        { requestId: 42, detail: "Stale pending interaction request" },
        3,
      ),
    ]);

    expect(state.pending.map(({ requestId }) => requestId)).toEqual(["keep"]);
  });

  it("clears pending dialogs and ephemeral presentation for a terminal session", () => {
    const activities = [
      request("outside-turn", { kind: "input", title: "Extension input" }, 1),
      activity(
        "terminal-status",
        "session-presentation.updated",
        { presentation: { kind: "status", key: "mode", text: "Working" } },
        2,
      ),
      activity(
        "terminal-notification",
        "session-presentation.updated",
        { presentation: { kind: "notification", message: "Working", level: "info" } },
        3,
      ),
    ];
    expect(foldSessionInteractionActivities(activities).pending).toHaveLength(1);
    expect(foldSessionInteractionActivities(activities, { terminalSession: true })).toMatchObject({
      pending: [],
      failures: [],
      statuses: [],
      widgets: [],
      notification: null,
    });
  });

  it("folds status and widget keys, including explicit absent-content clears", () => {
    const state = foldSessionInteractionActivities([
      activity(
        "status-one",
        "session-presentation.updated",
        { presentation: { kind: "status", key: "build", text: "Starting" } },
        1,
      ),
      activity(
        "status-update",
        "session-presentation.updated",
        { presentation: { kind: "status", key: "build", text: "Compiling" } },
        2,
      ),
      activity(
        "status-clear",
        "session-presentation.updated",
        { presentation: { kind: "status", key: "build" } },
        3,
      ),
      activity(
        "widget-above",
        "session-presentation.updated",
        { presentation: { kind: "widget", key: "plan", lines: ["One", "Two"] } },
        4,
      ),
      activity(
        "widget-below",
        "session-presentation.updated",
        {
          presentation: {
            kind: "widget",
            key: "tests",
            lines: ["Passing"],
            placement: "belowEditor",
          },
        },
        5,
      ),
      activity(
        "widget-clear",
        "session-presentation.updated",
        { presentation: { kind: "widget", key: "plan" } },
        6,
      ),
      activity(
        "widget-empty-start",
        "session-presentation.updated",
        { presentation: { kind: "widget", key: "empty", lines: ["Temporary"] } },
        7,
      ),
      activity(
        "widget-empty-clear",
        "session-presentation.updated",
        { presentation: { kind: "widget", key: "empty", lines: [] } },
        8,
      ),
    ]);

    expect(state.statuses).toEqual([]);
    expect(state.widgets).toEqual([{ key: "tests", lines: ["Passing"], placement: "belowEditor" }]);
  });

  it("retains the latest strictly decoded notification and bounds rendered text", () => {
    const state = foldSessionInteractionActivities([
      activity(
        "notification",
        "session-presentation.updated",
        { presentation: { kind: "notification", message: "Saved", level: "info" } },
        1,
      ),
      activity(
        "malformed-notification",
        "session-presentation.updated",
        { presentation: { kind: "notification", message: "No level" } },
        2,
      ),
    ]);

    expect(state.notification).toEqual({ id: "notification", message: "Saved", level: "info" });
    const compact = compactSessionPresentationText(`safe\u0000${"x".repeat(2_000)}`);
    expect(compact).not.toContain("\u0000");
    expect(compact.length).toBe(1_000);
    expect(compact.endsWith("…")).toBe(true);
  });
});

describe("buildSessionInteractionCommandInput", () => {
  it("builds the exact typed interaction response command payload", () => {
    expect(
      buildSessionInteractionCommandInput(
        ThreadId.make("thread-1"),
        SessionInteractionRequestId.make("opaque/request:1"),
        { kind: "submitted", value: "answer" },
      ),
    ).toEqual({
      threadId: "thread-1",
      requestId: "opaque/request:1",
      response: { kind: "submitted", value: "answer" },
    });
  });
});
