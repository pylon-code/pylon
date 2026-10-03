import { useEffect, useRef } from "react";

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
