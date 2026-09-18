import type {
  AgentAwarenessPhase,
  AgentAwarenessState,
  ProjectThreadAwarenessInput,
} from "@t3tools/shared/agentAwareness";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import type { ClientSettings } from "@t3tools/contracts/settings";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface AwarenessNotificationPreferences {
  readonly enabled: boolean;
  readonly notifyOnApproval: boolean;
  readonly notifyOnInput: boolean;
  readonly notifyOnCompletion: boolean;
  readonly notifyOnFailure: boolean;
}

export function selectAwarenessNotificationPreferences(
  settings: ClientSettings,
): AwarenessNotificationPreferences {
  return {
    enabled: settings.desktopNotificationsEnabled,
    notifyOnApproval: settings.desktopNotifyOnApproval,
    notifyOnInput: settings.desktopNotifyOnInput,
    notifyOnCompletion: settings.desktopNotifyOnCompletion,
    notifyOnFailure: settings.desktopNotifyOnFailure,
  };
}

/**
 * What crosses the IPC boundary to the main process. The mobile-shaped
 * `deepLink` string is deliberately not used: the web router's thread route
 * is `/$environmentId/$threadId`, so the ids travel as fields and the click
 * listener navigates by params.
 */
export interface AwarenessNotificationCandidate {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly body: string;
}

export type ThreadPhaseMap = ReadonlyMap<string, string>;

function awarenessThreadKey(state: Pick<AgentAwarenessState, "environmentId" | "threadId">) {
  return `${state.environmentId}:${state.threadId}`;
}

function preferenceAllowsPhase(
  phase: AgentAwarenessPhase,
  preferences: AwarenessNotificationPreferences,
): boolean {
  if (!preferences.enabled) return false;
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    default:
      // starting, running, stale never notify.
      return false;
  }
}

function buildCandidate(state: AgentAwarenessState): AwarenessNotificationCandidate {
  return {
    environmentId: state.environmentId,
    threadId: state.threadId,
    title: state.projectTitle ? `${state.threadTitle} — ${state.projectTitle}` : state.threadTitle,
    body: state.detail === undefined ? state.headline : `${state.headline} — ${state.detail}`,
  };
}

/** Map thread shells to awareness states through the shared cascade. */
export function projectAwarenessStates(input: {
  readonly threads: ReadonlyArray<
    {
      readonly environmentId: EnvironmentId;
      readonly projectId: string;
      readonly archivedAt?: string | null;
    } & ProjectThreadAwarenessInput["thread"]
  >;
  readonly projectTitleByKey: ReadonlyMap<string, string>;
}): Array<AgentAwarenessState & { readonly eventKey: string }> {
  const states: Array<AgentAwarenessState & { readonly eventKey: string }> = [];
  for (const thread of input.threads) {
    if (thread.archivedAt != null) continue;
    const state = projectThreadAwareness({
      environmentId: thread.environmentId,
      project: {
        title: input.projectTitleByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? "",
      },
      thread,
    });
    if (state !== null) {
      // A batched snapshot may skip running entirely between two finished turns.
      // Names, usage and other metadata must not create a new notification.
      const turn = thread.latestTurn;
      states.push({
        ...state,
        eventKey: JSON.stringify([
          state.phase,
          turn?.turnId ?? null,
          state.phase === "completed" ? (turn?.completedAt ?? null) : null,
        ]),
      });
    }
  }
  return states;
}

function isOlderCompletion(previous: string, current: string): boolean {
  try {
    const before: unknown = JSON.parse(previous);
    const after: unknown = JSON.parse(current);
    return (
      Array.isArray(before) &&
      Array.isArray(after) &&
      before[0] === "completed" &&
      after[0] === "completed" &&
      typeof before[2] === "string" &&
      typeof after[2] === "string" &&
      Date.parse(after[2]) < Date.parse(before[2])
    );
  } catch {
    return false;
  }
}

/**
 * The whole feature's brain. Two rules, both load-bearing:
 *
 * 1. A thread key absent from previousPhases primes without notifying, so
 *    launch bursts (the coordinator clears this baseline before reconnect)
 *    are silent. Threads absent from the snapshot drop out of nextPhases, so
 *    a reappearing thread re-primes rather than firing on stale history.
 * 2. The phase map updates unconditionally; preferences gate only emission.
 *    A suppressed transition is recorded and never replayed — flipping a
 *    toggle on later cannot flood the user with the past.
 */
export function reconcileAwarenessNotifications(input: {
  readonly previousPhases: ThreadPhaseMap;
  readonly states: ReadonlyArray<AgentAwarenessState & { readonly eventKey?: string }>;
  readonly preferences: AwarenessNotificationPreferences;
}): {
  readonly notifications: ReadonlyArray<AwarenessNotificationCandidate>;
  readonly nextPhases: ThreadPhaseMap;
} {
  const notifications: AwarenessNotificationCandidate[] = [];
  const nextPhases = new Map<string, string>();
  for (const state of input.states) {
    const key = awarenessThreadKey(state);
    const previousPhase = input.previousPhases.get(key);
    const eventKey = state.eventKey ?? state.phase;
    nextPhases.set(key, eventKey);
    if (previousPhase === undefined || previousPhase === eventKey) continue;
    if (isOlderCompletion(previousPhase, eventKey)) continue;
    if (!preferenceAllowsPhase(state.phase, input.preferences)) continue;
    notifications.push(buildCandidate(state));
  }
  return { notifications, nextPhases };
}
