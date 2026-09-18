import { ThreadId } from "@t3tools/contracts";

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
