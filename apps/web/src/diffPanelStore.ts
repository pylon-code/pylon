import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  | { kind: "turn"; turnId: RunId; filePath: string | null; revealRequestId: number };

export type DiffGitScope = "branch" | "unstaged";

// "branch" is the Changes view: everything this checkout changed since its base.
const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };

/**
 * The scope a generic diff panel opening shows. Servers that report Changes totals
 * (`branchChanges`) diff the branch range against the working tree, so Changes is the
 * default. Older servers diff it from HEAD and the thread panel counts only uncommitted
 * edits, so the uncommitted view is the one that matches those counts. Until status
 * loads, Changes is assumed; the default is resolved live and corrects itself.
 */
export function resolveDefaultDiffGitScope(
  status: { readonly branchChanges?: unknown } | null | undefined,
): DiffGitScope {
  return status && status.branchChanges === undefined ? "unstaged" : "branch";
}

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  selectGitScope: (ref: ScopedThreadRef, scope: DiffGitScope) => void;
  /** Drops an explicit selection so the panel follows `resolveDefaultDiffGitScope`. */
  selectDefaultGitScope: (ref: ScopedThreadRef) => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectTurn: (ref: ScopedThreadRef, turnId: RunId, filePath?: string) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<RunId>) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      selectGitScope: (ref, scope) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const previousBaseRef =
            previous?.kind === "branch"
              ? previous.baseRef
              : (state.branchBaseRefByThreadKey[threadKey] ?? null);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]:
                scope === "branch"
                  ? { kind: "branch", baseRef: previousBaseRef }
                  : { kind: "unstaged" },
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch"
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          };
        }),
      selectDefaultGitScope: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          if (previous === undefined) return state;
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          return {
            byThreadKey,
            branchBaseRefByThreadKey:
              previous.kind === "branch"
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          };
        }),
      selectBranchBaseRef: (ref, baseRef) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "branch", baseRef: normalizedBaseRef },
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [threadKey]: normalizedBaseRef,
            },
          };
        }),
      selectTurn: (ref, turnId, filePath) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "turn",
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
              },
            },
          };
        }),
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const latestTurnId = availableTurnIds[0];
          if (
            previous?.kind !== "turn" ||
            latestTurnId === undefined ||
            availableTurnIds.includes(previous.turnId)
          ) {
            return state;
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...previous, turnId: latestTurnId },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey) && !(threadKey in state.branchBaseRefByThreadKey)) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            state.branchBaseRefByThreadKey;
          return { byThreadKey, branchBaseRefByThreadKey };
        }),
    }),
    {
      name: "t3code:diff-panel-state:v1",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
      }),
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_SELECTION;
}

/** The thread's explicit selection, or undefined when it follows the default scope. */
export function selectExplicitThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
): DiffPanelSelection | undefined {
  return ref ? byThreadKey[scopedThreadKey(ref)] : undefined;
}

export function selectThreadBranchBaseRef(
  branchBaseRefByThreadKey: Record<string, string | null>,
  ref: ScopedThreadRef | null | undefined,
): string | null {
  return ref ? (branchBaseRefByThreadKey[scopedThreadKey(ref)] ?? null) : null;
}

export function resolveThreadDiffPanelSelection(input: {
  readonly explicit: DiffPanelSelection | undefined;
  readonly defaultScope: DiffGitScope;
  readonly branchBaseRef: string | null;
}): DiffPanelSelection {
  if (input.explicit) return input.explicit;
  return input.defaultScope === "unstaged"
    ? { kind: "unstaged" }
    : { kind: "branch", baseRef: input.branchBaseRef };
}
