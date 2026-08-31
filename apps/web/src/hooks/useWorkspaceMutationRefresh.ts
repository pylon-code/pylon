import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

const WORKSPACE_MUTATION_ITEM_TYPES = new Set(["command_execution", "file_change"]);

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload !== null && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

/**
 * The latest provider event after which files on disk may have changed.
 * File tools are explicit; completed commands are included because a shell
 * command can mutate the workspace without reporting the paths it touched.
 */
export function latestWorkspaceMutationId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): string | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) continue;
    const payload = activityPayload(activity);
    const terminalUpdate =
      activity.kind === "tool.updated" &&
      typeof payload?.status === "string" &&
      payload.status !== "inProgress" &&
      payload.status !== "in_progress";
    if (activity.kind !== "tool.completed" && !terminalUpdate) continue;
    const itemType = payload?.itemType;
    if (typeof itemType === "string" && WORKSPACE_MUTATION_ITEM_TYPES.has(itemType)) {
      return activity.id;
    }
  }
  return null;
}

export function workspaceMutationRefreshToken(
  resourceKey: string,
  mutationId: string | null,
): string | null {
  return mutationId === null ? null : `${resourceKey}\u0000${mutationId}`;
}

/**
 * A busy turn lands a mutation every few hundred milliseconds, and each refresh
 * costs a git subprocess or a full-tree payload. Coalesce a burst into one
 * trailing refresh rather than issuing one per tool call.
 */
export const WORKSPACE_MUTATION_REFRESH_COALESCE_MS = 750;

/**
 * Refreshes once per settled burst of mutations, per resource. Disabled
 * mutations stay pending, which lets an editable file catch up after its local
 * save finishes.
 *
 * The first observed mutation is adopted without refreshing: on mount the atom
 * has just issued its own read, and refreshing would cancel and re-issue it.
 */
export function useWorkspaceMutationRefresh(input: {
  readonly enabled?: boolean;
  readonly mutationId: string | null;
  readonly refresh: () => void;
  readonly resourceKey: string;
}): void {
  const { enabled = true, mutationId, refresh, resourceKey } = input;
  const handledTokenRef = useRef<string | null>(null);
  const seededResourceRef = useRef<string | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) return;
    const token = workspaceMutationRefreshToken(resourceKey, mutationId);
    if (seededResourceRef.current !== resourceKey) {
      // Opening a panel mid-turn already has a mutation id in hand, and the atom
      // has just issued its own read: adopt that state instead of cancelling it.
      seededResourceRef.current = resourceKey;
      handledTokenRef.current = token;
      return;
    }
    if (token === null || token === handledTokenRef.current) return;
    handledTokenRef.current = token;
    const timer = setTimeout(() => {
      refreshRef.current();
    }, WORKSPACE_MUTATION_REFRESH_COALESCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [enabled, mutationId, resourceKey]);
}
