import { isScratchProject } from "@t3tools/client-runtime/state/projects";

import type { ThreadShell } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "worktreePath">>,
  threadId: ThreadShell["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const isShared = threads.some((thread) => {
    if (thread.id === threadId) {
      return false;
    }
    return normalizeWorktreePath(thread.worktreePath) === targetWorktreePath;
  });

  return isShared ? null : targetWorktreePath;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}

/**
 * Whether deleting a thread may offer to remove its folder as a Git worktree.
 * Scratch ("No project") threads run in plain folders under the Scratch
 * project; they are never worktrees, and deleting one keeps its files.
 */
export function canOfferWorktreeDeletion(input: {
  readonly worktreePath: string | null;
  readonly project: { readonly workspaceRoot: string } | null;
  readonly scratchWorkspaceRoot: string | null | undefined;
}): boolean {
  return (
    input.worktreePath !== null &&
    input.project !== null &&
    !isScratchProject(input.project, input.scratchWorkspaceRoot)
  );
}
