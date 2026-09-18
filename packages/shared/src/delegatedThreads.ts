import { sha256 } from "@noble/hashes/sha2";
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

/** The delegation key reserved for a thread's pair executor. The server's fan-out tools refuse it. */
export const PAIR_DELEGATION_KEY = "pair";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The id of a lead's pair executor. It is the delegated child id for the
 * reserved key, so every client and the server derive it from the lead's id
 * and nothing has to record the link. Synchronous so it can run in a render.
 */
export function pairExecutorThreadId(leadThreadId: ThreadId): ThreadId {
  const digest = sha256(new TextEncoder().encode(`${leadThreadId}\n${PAIR_DELEGATION_KEY}`));
  return ThreadId.make(`${DELEGATED_THREAD_ID_PREFIX}${leadThreadId}:${hex(digest).slice(0, 16)}`);
}

/** Whether a thread is some lead's pair executor, rather than a fan-out child. */
export function isPairExecutorThreadId(threadId: ThreadId): boolean {
  const lead = delegatedParentThreadId(threadId);
  return lead !== null && pairExecutorThreadId(lead) === threadId;
}
