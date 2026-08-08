import {
  decodeOrchestrationSessionActivity,
  type OrchestrationSessionActivity,
  type OrchestrationThreadActivity,
  type SessionInteractionRequest,
  type SessionInteractionRequestId,
  type SessionInteractionResponse,
  type SessionNotificationLevel,
  type SessionWidgetPlacement,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

export interface PendingSessionInteraction {
  readonly activityId: string;
  readonly requestId: SessionInteractionRequestId;
  readonly request: SessionInteractionRequest;
  readonly createdAt: string;
}

export interface SessionNotificationActivity {
  readonly activityId: string;
  readonly createdAt: string;
  readonly turnId: OrchestrationThreadActivity["turnId"];
  readonly message: string;
  readonly level: SessionNotificationLevel;
}

export interface SessionStatusPresentation {
  readonly key: string;
  readonly text: string;
}

export interface SessionWidgetPresentation {
  readonly key: string;
  readonly lines: ReadonlyArray<string>;
  readonly placement: SessionWidgetPlacement;
}

export interface SessionInteractionResponseFailure {
  readonly activityId: string;
  readonly requestId: SessionInteractionRequestId;
  readonly error: string;
}

export interface SessionInteractionActivityState {
  readonly pending: ReadonlyArray<PendingSessionInteraction>;
  readonly responseFailures: ReadonlyArray<SessionInteractionResponseFailure>;
  readonly notifications: ReadonlyArray<SessionNotificationActivity>;
  readonly statuses: ReadonlyArray<SessionStatusPresentation>;
  readonly widgets: ReadonlyArray<SessionWidgetPresentation>;
}

function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const timestampOrder = left.createdAt.localeCompare(right.createdAt);
  if (timestampOrder !== 0) return timestampOrder;
  const leftRank = left.kind.endsWith(".resolved") ? 2 : left.kind.endsWith(".requested") ? 0 : 1;
  const rightRank = right.kind.endsWith(".resolved")
    ? 2
    : right.kind.endsWith(".requested")
      ? 0
      : 1;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return left.id.localeCompare(right.id);
}

function terminalInteractionFailure(activity: OrchestrationThreadActivity): {
  readonly requestId: string;
  readonly stale: boolean;
} | null {
  if (activity.kind !== "provider.interaction.respond.failed") return null;
  if (typeof activity.payload !== "object" || activity.payload === null) return null;
  const payload = activity.payload as Record<string, unknown>;
  if (typeof payload.requestId !== "string" || typeof payload.detail !== "string") return null;
  const detail = payload.detail.toLowerCase();
  return {
    requestId: payload.requestId,
    stale:
      detail.includes("stale pending interaction request") ||
      detail.includes("unknown pending interaction request"),
  };
}

/**
 * Folds the committed generic activity stream into provider-neutral interaction UI state.
 * Canonical activities are accepted only through the contracts decoder; malformed legacy
 * payloads are deliberately inert.
 */
export function foldSessionInteractionActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options: { readonly terminalSession?: boolean } = {},
): SessionInteractionActivityState {
  const pendingByRequestId = new Map<string, PendingSessionInteraction>();
  const failuresByRequestId = new Map<string, SessionInteractionResponseFailure>();
  const statusesByKey = new Map<string, SessionStatusPresentation>();
  const widgetsByKey = new Map<string, SessionWidgetPresentation>();
  const notifications: SessionNotificationActivity[] = [];

  for (const activity of [...activities].toSorted(compareActivities)) {
    const decoded = decodeOrchestrationSessionActivity(activity);
    if (Option.isNone(decoded)) {
      const failure = terminalInteractionFailure(activity);
      if (failure === null) continue;
      if (failure.stale) {
        pendingByRequestId.delete(failure.requestId);
        failuresByRequestId.delete(failure.requestId);
      } else {
        const pending = pendingByRequestId.get(failure.requestId);
        if (pending !== undefined) {
          failuresByRequestId.set(failure.requestId, {
            activityId: activity.id,
            requestId: pending.requestId,
            error: "The session could not accept that response. Try again.",
          });
        }
      }
      continue;
    }

    const sessionActivity: OrchestrationSessionActivity = decoded.value;
    if (sessionActivity.kind === "interaction.requested") {
      failuresByRequestId.delete(sessionActivity.payload.requestId);
      pendingByRequestId.set(sessionActivity.payload.requestId, {
        activityId: sessionActivity.id,
        requestId: sessionActivity.payload.requestId,
        request: sessionActivity.payload.request,
        createdAt: sessionActivity.createdAt,
      });
      continue;
    }
    if (sessionActivity.kind === "interaction.resolved") {
      pendingByRequestId.delete(sessionActivity.payload.requestId);
      failuresByRequestId.delete(sessionActivity.payload.requestId);
      continue;
    }

    const presentation = sessionActivity.payload.presentation;
    if (presentation.kind === "notification") {
      notifications.push({
        activityId: sessionActivity.id,
        createdAt: sessionActivity.createdAt,
        turnId: sessionActivity.turnId,
        message: presentation.message,
        level: presentation.level,
      });
      continue;
    }
    if (presentation.kind === "status") {
      statusesByKey.delete(presentation.key);
      if (presentation.text !== undefined) {
        statusesByKey.set(presentation.key, { key: presentation.key, text: presentation.text });
      }
      continue;
    }

    widgetsByKey.delete(presentation.key);
    if (presentation.lines !== undefined && presentation.lines.length > 0) {
      widgetsByKey.set(presentation.key, {
        key: presentation.key,
        lines: presentation.lines,
        placement: presentation.placement ?? "aboveEditor",
      });
    }
  }

  if (options.terminalSession === true) {
    pendingByRequestId.clear();
    failuresByRequestId.clear();
    statusesByKey.clear();
    widgetsByKey.clear();
  }

  return {
    pending: [...pendingByRequestId.values()],
    responseFailures: [...failuresByRequestId.values()],
    notifications,
    statuses: [...statusesByKey.values()],
    widgets: [...widgetsByKey.values()],
  };
}

export type SessionInteractionSubmissionReconciliation =
  | { readonly kind: "keep" }
  | { readonly kind: "clear" }
  | { readonly kind: "failed"; readonly failure: SessionInteractionResponseFailure };

/** Keeps accepted commands locked until the committed stream resolves or rejects them. */
export function reconcileSessionInteractionSubmission(input: {
  readonly submission: {
    readonly requestId: string;
    readonly status: "submitting" | "submitted" | "error";
    readonly ignoredFailureActivityId?: string;
  };
  readonly state: SessionInteractionActivityState;
}): SessionInteractionSubmissionReconciliation {
  if (!input.state.pending.some((pending) => pending.requestId === input.submission.requestId)) {
    return { kind: "clear" };
  }
  const failure = input.state.responseFailures.find(
    (candidate) => candidate.requestId === input.submission.requestId,
  );
  if (
    failure !== undefined &&
    failure.activityId !== input.submission.ignoredFailureActivityId &&
    input.submission.status !== "error"
  ) {
    return { kind: "failed", failure };
  }
  return { kind: "keep" };
}

export function buildSessionInteractionCommandInput(input: {
  readonly threadId: ThreadId;
  readonly requestId: SessionInteractionRequestId;
  readonly response: SessionInteractionResponse;
}) {
  return {
    threadId: input.threadId,
    requestId: input.requestId,
    response: input.response,
  };
}
