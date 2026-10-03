import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { ProjectIconOverride } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

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

/** The icon the server gives the Scratch project when it creates it. */
function hasScratchProjectIcon(project: {
  readonly projectIcon?: ProjectIconOverride | null | undefined;
}): boolean {
  return project.projectIcon?.kind === "lucide" && project.projectIcon.name === SCRATCH_ICON_NAME;
}

const SCRATCH_ICON_NAME = "message-square-dashed";

function isPathInside(child: string, parent: string): boolean {
  const root = normalizeProjectPathForComparison(parent);
  const path = normalizeProjectPathForComparison(child);
  return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
}

/**
 * Whether deleting a thread may offer to remove its folder as a Git worktree.
 * Scratch ("No project") threads run in plain folders under the Scratch
 * project; they are never worktrees, and deleting one keeps its files. This
 * fails closed: without the environment's config it offers nothing, and a
 * folder under the Scratch root or a project still marked as Scratch counts
 * as Scratch even when the environment no longer advertises its root.
 */
export function canOfferWorktreeDeletion(input: {
  readonly worktreePath: string | null;
  readonly project: {
    readonly workspaceRoot: string;
    readonly projectIcon?: ProjectIconOverride | null | undefined;
  } | null;
  /** The environment's config, or null while it is not loaded. */
  readonly serverConfig: { readonly scratchWorkspaceRoot?: string | undefined } | null;
}): boolean {
  const { worktreePath, project, serverConfig } = input;
  if (worktreePath === null || project === null || serverConfig === null) return false;
  const scratchRoot = serverConfig.scratchWorkspaceRoot;
  if (scratchRoot !== undefined) {
    if (isScratchProject(project, scratchRoot) || isPathInside(worktreePath, scratchRoot)) {
      return false;
    }
  }
  return !hasScratchProjectIcon(project);
}
