import {
  SessionInteractionRequestId,
  decodeOrchestrationSessionActivity,
  type OrchestrationThreadActivity,
  type SessionInteractionRequest,
  type SessionInteractionResponse,
  type SessionNotificationLevel,
  type SessionWidgetPlacement,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface PendingSessionInteraction {
  readonly requestId: SessionInteractionRequestId;
  readonly request: SessionInteractionRequest;
  readonly turnId: TurnId | null;
  readonly createdAt: string;
}

export interface CurrentSessionStatus {
  readonly key: string;
  readonly text: string;
}

export interface CurrentSessionWidget {
  readonly key: string;
  readonly lines: ReadonlyArray<string>;
  readonly placement: SessionWidgetPlacement;
}

export interface CurrentSessionNotification {
  readonly id: string;
  readonly message: string;
  readonly level: SessionNotificationLevel;
}

export interface SessionInteractionFailure {
  readonly id: string;
  readonly requestId: SessionInteractionRequestId;
  readonly message: string;
}

export interface SessionInteractionPresentationState {
  readonly pending: ReadonlyArray<PendingSessionInteraction>;
  readonly statuses: ReadonlyArray<CurrentSessionStatus>;
  readonly widgets: ReadonlyArray<CurrentSessionWidget>;
  readonly notification: CurrentSessionNotification | null;
  readonly failures: ReadonlyArray<SessionInteractionFailure>;
}

const decodeRequestId = Schema.decodeUnknownOption(SessionInteractionRequestId);
const INTERACTION_RESPONSE_FAILED_MESSAGE =
  "The session did not accept this response. Try again or cancel.";

function interactionFailure(activity: OrchestrationThreadActivity): {
  readonly requestId: SessionInteractionRequestId;
  readonly stale: boolean;
} | null {
  if (activity.kind !== "provider.interaction.respond.failed") {
    return null;
  }
  const payload =
    typeof activity.payload === "object" && activity.payload !== null
      ? (activity.payload as Record<string, unknown>)
      : null;
  const requestId = Option.getOrNull(decodeRequestId(payload?.requestId));
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (requestId === null || detail === null) {
    return null;
  }
  return {
    requestId,
    stale:
      detail.includes("stale pending interaction request") ||
      detail.includes("unknown pending interaction request"),
  };
}

/**
 * Folds the already lifecycle-ordered activity stream. Provider-neutral
 * payloads are accepted only through the contracts decoder; malformed or
 * future variants remain ordinary timeline activities.
 */
export function foldSessionInteractionActivities(
  orderedActivities: ReadonlyArray<OrchestrationThreadActivity>,
  options: { readonly terminalSession?: boolean } = {},
): SessionInteractionPresentationState {
  const pendingById = new Map<SessionInteractionRequestId, PendingSessionInteraction>();
  const statusesByKey = new Map<string, CurrentSessionStatus>();
  const widgetsByKey = new Map<string, CurrentSessionWidget>();
  const failuresByRequestId = new Map<SessionInteractionRequestId, SessionInteractionFailure>();
  let notification: CurrentSessionNotification | null = null;

  for (const activity of orderedActivities) {
    const decoded = Option.getOrNull(decodeOrchestrationSessionActivity(activity));
    if (decoded === null) {
      const failure = interactionFailure(activity);
      if (failure !== null) {
        if (failure.stale) {
          pendingById.delete(failure.requestId);
          failuresByRequestId.delete(failure.requestId);
        } else if (pendingById.has(failure.requestId)) {
          failuresByRequestId.set(failure.requestId, {
            id: activity.id,
            requestId: failure.requestId,
            message: INTERACTION_RESPONSE_FAILED_MESSAGE,
          });
        }
      }
      continue;
    }

    switch (decoded.kind) {
      case "interaction.requested":
        failuresByRequestId.delete(decoded.payload.requestId);
        pendingById.set(decoded.payload.requestId, {
          requestId: decoded.payload.requestId,
          request: decoded.payload.request,
          turnId: decoded.turnId,
          createdAt: decoded.createdAt,
        });
        break;
      case "interaction.resolved":
        pendingById.delete(decoded.payload.requestId);
        failuresByRequestId.delete(decoded.payload.requestId);
        break;
      case "session-presentation.updated": {
        const presentation = decoded.payload.presentation;
        switch (presentation.kind) {
          case "notification":
            notification = {
              id: decoded.id,
              message: presentation.message,
              level: presentation.level,
            };
            break;
          case "status":
            if (presentation.text === undefined) {
              statusesByKey.delete(presentation.key);
            } else {
              statusesByKey.delete(presentation.key);
              statusesByKey.set(presentation.key, {
                key: presentation.key,
                text: presentation.text,
              });
            }
            break;
          case "widget":
            if (presentation.lines === undefined || presentation.lines.length === 0) {
              widgetsByKey.delete(presentation.key);
            } else {
              widgetsByKey.delete(presentation.key);
              widgetsByKey.set(presentation.key, {
                key: presentation.key,
                lines: presentation.lines,
                placement: presentation.placement ?? "aboveEditor",
              });
            }
            break;
        }
        break;
      }
    }
  }

  if (options.terminalSession === true) {
    pendingById.clear();
    failuresByRequestId.clear();
    statusesByKey.clear();
    widgetsByKey.clear();
    notification = null;
  }

  return {
    pending: [...pendingById.values()],
    statuses: [...statusesByKey.values()],
    widgets: [...widgetsByKey.values()],
    notification,
    failures: [...failuresByRequestId.values()],
  };
}

export function buildSessionInteractionCommandInput(
  threadId: ThreadId,
  requestId: SessionInteractionRequestId,
  response: SessionInteractionResponse,
) {
  return { threadId, requestId, response } as const;
}

const COMPACT_PRESENTATION_TEXT_MAX_CHARS = 1_000;

/** Keeps persisted provider text cheap to lay out in compact native surfaces. */
export function compactSessionPresentationText(value: string): string {
  const normalized = value.replaceAll("\u0000", "");
  if (normalized.length <= COMPACT_PRESENTATION_TEXT_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, COMPACT_PRESENTATION_TEXT_MAX_CHARS - 1)}…`;
}
