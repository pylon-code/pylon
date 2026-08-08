import {
  EventId,
  OrchestrationThreadActivity,
  SessionInteractionRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSessionInteractionCommandInput,
  foldSessionInteractionActivities,
  reconcileSessionInteractionSubmission,
} from "./sessionInteraction";

const decodeActivity = Schema.decodeUnknownSync(OrchestrationThreadActivity);
const requestId = SessionInteractionRequestId.make("request-1");

function activity(input: {
  id: string;
  kind: string;
  payload: unknown;
  sequence?: number;
  createdAt?: string;
}) {
  return decodeActivity({
    id: EventId.make(input.id),
    kind: input.kind,
    tone: "info",
    summary: "Session activity",
    payload: input.payload,
    turnId: null,
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    createdAt: input.createdAt ?? "2026-03-01T00:00:00.000Z",
  });
}

function requested(sequence = 1) {
  return activity({
    id: "requested",
    kind: "interaction.requested",
    sequence,
    payload: {
      requestId,
      request: { kind: "select", title: "Choose", options: ["A", "B"] },
    },
  });
}

describe("foldSessionInteractionActivities", () => {
  it("orders activities and clears pending requests on resolution", () => {
    const resolved = activity({
      id: "resolved",
      kind: "interaction.resolved",
      sequence: 2,
      payload: { requestId, response: { kind: "selected", value: "A" } },
    });

    expect(foldSessionInteractionActivities([resolved, requested()]).pending).toEqual([]);
    expect(foldSessionInteractionActivities([requested()]).pending).toMatchObject([
      { requestId, request: { kind: "select", options: ["A", "B"] } },
    ]);
    expect(
      foldSessionInteractionActivities([requested()], { terminalSession: true }).pending,
    ).toEqual([]);
  });

  it("clears only stale or unknown terminal response failures", () => {
    const ordinaryFailure = activity({
      id: "failed-ordinary",
      kind: "provider.interaction.respond.failed",
      sequence: 2,
      payload: { requestId, detail: "Provider is temporarily unavailable" },
    });
    const staleFailure = activity({
      id: "failed-stale",
      kind: "provider.interaction.respond.failed",
      sequence: 3,
      payload: { requestId, detail: "Stale pending interaction request: request-1" },
    });

    const retryableState = foldSessionInteractionActivities([requested(), ordinaryFailure]);
    expect(retryableState.pending).toHaveLength(1);
    expect(retryableState.responseFailures).toEqual([
      {
        activityId: "failed-ordinary",
        requestId,
        error: "The session could not accept that response. Try again.",
      },
    ]);
    expect(retryableState.responseFailures[0]?.error).not.toContain("temporarily unavailable");
    const staleState = foldSessionInteractionActivities([requested(), staleFailure]);
    expect(staleState.pending).toEqual([]);
    expect(staleState.responseFailures).toEqual([]);
  });

  it("folds notifications and latest keyed presentation updates with clearing", () => {
    const activities = [
      activity({
        id: "status-1",
        kind: "session-presentation.updated",
        sequence: 1,
        payload: { presentation: { kind: "status", key: "mode", text: "Planning" } },
      }),
      activity({
        id: "widget-1",
        kind: "session-presentation.updated",
        sequence: 2,
        payload: {
          presentation: {
            kind: "widget",
            key: "tasks",
            lines: ["First"],
            placement: "belowEditor",
          },
        },
      }),
      activity({
        id: "notice",
        kind: "session-presentation.updated",
        sequence: 3,
        payload: {
          presentation: { kind: "notification", message: "Review requested", level: "warning" },
        },
      }),
      activity({
        id: "status-clear",
        kind: "session-presentation.updated",
        sequence: 4,
        payload: { presentation: { kind: "status", key: "mode" } },
      }),
      activity({
        id: "widget-clear",
        kind: "session-presentation.updated",
        sequence: 5,
        payload: { presentation: { kind: "widget", key: "tasks", lines: [] } },
      }),
      activity({
        id: "widget-latest",
        kind: "session-presentation.updated",
        sequence: 6,
        payload: { presentation: { kind: "widget", key: "summary", lines: ["Ready"] } },
      }),
    ];

    const state = foldSessionInteractionActivities(activities);
    expect(state.statuses).toEqual([]);
    expect(state.widgets).toEqual([{ key: "summary", lines: ["Ready"], placement: "aboveEditor" }]);
    expect(state.notifications).toMatchObject([
      { activityId: "notice", message: "Review requested", level: "warning" },
    ]);

    const terminal = foldSessionInteractionActivities(activities, { terminalSession: true });
    expect(terminal.statuses).toEqual([]);
    expect(terminal.widgets).toEqual([]);
    expect(terminal.notifications).toHaveLength(1);
  });

  it("keeps malformed canonical and legacy payloads inert", () => {
    const malformedRequest = activity({
      id: "malformed",
      kind: "interaction.requested",
      payload: { requestId, request: { kind: "select", title: "Choose", options: [] } },
    });
    const legacy = activity({
      id: "legacy",
      kind: "legacy.session.dialog",
      payload: { requestId, request: { kind: "confirm", title: "Unsafe legacy shape" } },
    });

    const state = foldSessionInteractionActivities([malformedRequest, legacy]);
    expect(state).toEqual({
      pending: [],
      responseFailures: [],
      notifications: [],
      statuses: [],
      widgets: [],
    });
  });
});

describe("reconcileSessionInteractionSubmission", () => {
  const response = { kind: "selected" as const, value: "A" };

  it("keeps an accepted command locked until a committed resolution", () => {
    const pendingState = foldSessionInteractionActivities([requested()]);
    expect(
      reconcileSessionInteractionSubmission({
        submission: { requestId, status: "submitted" },
        state: pendingState,
      }),
    ).toEqual({ kind: "keep" });

    const resolvedState = foldSessionInteractionActivities([
      requested(),
      activity({
        id: "resolved-after-command",
        kind: "interaction.resolved",
        sequence: 2,
        payload: { requestId, response },
      }),
    ]);
    expect(
      reconcileSessionInteractionSubmission({
        submission: { requestId, status: "submitted" },
        state: resolvedState,
      }),
    ).toEqual({ kind: "clear" });
  });

  it("unlocks on a new retryable provider failure but ignores an older failed attempt", () => {
    const failedState = foldSessionInteractionActivities([
      requested(),
      activity({
        id: "provider-failure",
        kind: "provider.interaction.respond.failed",
        sequence: 2,
        payload: { requestId, detail: "Native provider failure details" },
      }),
    ]);
    expect(
      reconcileSessionInteractionSubmission({
        submission: { requestId, status: "submitted" },
        state: failedState,
      }),
    ).toMatchObject({ kind: "failed", failure: { activityId: "provider-failure" } });
    expect(
      reconcileSessionInteractionSubmission({
        submission: {
          requestId,
          status: "submitting",
          ignoredFailureActivityId: "provider-failure",
        },
        state: failedState,
      }),
    ).toEqual({ kind: "keep" });
  });
});

describe("buildSessionInteractionCommandInput", () => {
  it.each([
    { kind: "selected" as const, value: "A" },
    { kind: "confirmed" as const, confirmed: true },
    { kind: "confirmed" as const, confirmed: false },
    { kind: "submitted" as const, value: "hello" },
    { kind: "cancelled" as const },
  ])("preserves the exact typed $kind response payload", (response) => {
    expect(
      buildSessionInteractionCommandInput({
        threadId: ThreadId.make("thread-1"),
        requestId,
        response,
      }),
    ).toEqual({ threadId: "thread-1", requestId: "request-1", response });
  });
});
