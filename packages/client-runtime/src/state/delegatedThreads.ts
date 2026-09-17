/**
 * Delegated child threads, as seen by clients.
 *
 * The server names a delegated child `delegated:<parentThreadId>:<16 hex>`
 * (apps/server/src/mcp/toolkits/delegation/logic.ts). The id is the only link
 * to the parent: no contract field carries it.
 *
 * @module state/delegatedThreads
 */
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";

type ScopedThread = { readonly environmentId: EnvironmentId; readonly id: ThreadId };

const keyOf = (thread: ScopedThread) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

const DELEGATED_THREAD_ID_PREFIX = "delegated:";
const CHILD_SUFFIX_PATTERN = /:[0-9a-f]{16}$/;

/**
 * The parent of a delegated child, or null for any other thread. Parent ids
 * can contain colons, so the parent is everything between the prefix and the
 * fixed-width suffix rather than a split on `:`.
 */
export function delegatedParentThreadId(threadId: ThreadId): ThreadId | null {
  if (!threadId.startsWith(DELEGATED_THREAD_ID_PREFIX)) return null;
  const rest = threadId.slice(DELEGATED_THREAD_ID_PREFIX.length);
  const suffix = CHILD_SUFFIX_PATTERN.exec(rest);
  if (suffix === null || suffix.index === 0) return null;
  return ThreadId.make(rest.slice(0, suffix.index));
}

export interface NestedDelegatedThreads<T> {
  /** Threads that render as their own rows, in input order. */
  readonly topLevel: readonly T[];
  /** Children by their parent's scoped thread key, each list in input order. */
  readonly childrenByParentKey: ReadonlyMap<string, readonly T[]>;
}

/**
 * Nests each delegated child under its parent when the parent is in the same
 * list. A child whose parent is elsewhere (another section, archived, filtered
 * out, or not loaded) stays top-level, so a thread never disappears.
 */
export function nestDelegatedThreads<T extends ScopedThread>(
  threads: readonly T[],
): NestedDelegatedThreads<T> {
  const keys = new Set(threads.map(keyOf));
  const listedParentKey = (environmentId: EnvironmentId, threadId: ThreadId): string | null => {
    const parentId = delegatedParentThreadId(threadId);
    if (parentId === null) return null;
    const parentKey = keyOf({ environmentId, id: parentId });
    return keys.has(parentKey) ? parentKey : null;
  };
  const topLevel: T[] = [];
  const childrenByParentKey = new Map<string, T[]>();
  for (const thread of threads) {
    const parentKey = listedParentKey(thread.environmentId, thread.id);
    // Nesting is one level deep. The server never delegates from a child, but a
    // grandchild under a nested row would never render, so it stays top-level.
    const parentId = delegatedParentThreadId(thread.id);
    const parentIsNested =
      parentId !== null && listedParentKey(thread.environmentId, parentId) !== null;
    if (parentKey === null || parentIsNested) {
      topLevel.push(thread);
      continue;
    }
    const siblings = childrenByParentKey.get(parentKey);
    if (siblings === undefined) childrenByParentKey.set(parentKey, [thread]);
    else siblings.push(thread);
  }
  return { topLevel, childrenByParentKey };
}

/**
 * Rows in rendered order: each top-level row followed by its children. `rows`
 * is a subset of `nested.topLevel` when a list pages or collapses.
 */
export function flattenNestedThreads<T extends ScopedThread>(
  rows: readonly T[],
  nested: NestedDelegatedThreads<T>,
): T[] {
  return rows.flatMap((row) => [row, ...(nested.childrenByParentKey.get(keyOf(row)) ?? [])]);
}

/** Whether showing `row` shows the thread with `threadKey`, as itself or a nested child. */
export function nestedRowContainsThread<T extends ScopedThread>(
  row: T,
  nested: NestedDelegatedThreads<T>,
  threadKey: string,
): boolean {
  const rowKey = keyOf(row);
  if (rowKey === threadKey) return true;
  return (
    nested.childrenByParentKey.get(rowKey)?.some((child) => keyOf(child) === threadKey) ?? false
  );
}

/** Shell-only lifecycle; keep admission/terminal precedence aligned with server delegation. */
function delegatedThreadStatus(shell: EnvironmentThreadShell) {
  if (shell.archivedAt !== null) return "archived";
  const { session, latestTurn: turn } = shell;
  if (session?.status === "error" || turn?.state === "error") return "error";
  if (
    session?.status !== "starting" &&
    session?.failedTurnRequestId !== undefined &&
    session.activeTurnId === null
  )
    return "error";
  if (shell.hasPendingApprovals) return "needs-approval";
  if (shell.hasPendingUserInput) return "needs-input";
  if (session?.status === "starting") return turn === null ? "starting" : "running";
  if (session?.status === "running" && session.activeTurnId !== null) return "running";
  if (turn === null) return session === null ? "starting" : "interrupted";
  if (turn.state === "running") return "running";
  if (turn.state === "interrupted") return "interrupted";
  if (
    turn.state === "completed" &&
    (session === null || session.activeTurnId === null) &&
    shell.backgroundLiveness !== "working"
  )
    return "completed";
  return "running";
}

/**
 * Compact delegated children from the existing environment shell subscription.
 * The parent's session is deliberately irrelevant: children can outlive it.
 * Completion means execution finished, not that the parent reviewed the result.
 */
export function delegatedThreadRows(
  threads: readonly EnvironmentThreadShell[],
  parent: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
) {
  return threads
    .filter(
      (thread) =>
        thread.environmentId === parent.environmentId &&
        delegatedParentThreadId(thread.id) === parent.threadId,
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
    .map((thread) => {
      const status = delegatedThreadStatus(thread);
      const activity =
        status === "error"
          ? thread.session?.lastError
          : status === "running"
            ? thread.planProgress?.step
            : null;
      return {
        threadId: thread.id,
        environmentId: thread.environmentId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        providerName: thread.session?.providerName ?? null,
        status,
        activity: activity?.replace(/\s+/g, " ").trim().slice(0, 160) || null,
      } as const;
    });
}
