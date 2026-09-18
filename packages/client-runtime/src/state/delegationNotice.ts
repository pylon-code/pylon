/**
 * The automatic message Pylon sends a parent when its delegated work changes
 * state is written for the agent: a preamble, one JSON line per child, and a
 * paragraph of rules. Shown raw, it reads as a wall of JSON in the user's own
 * voice. This turns it into what a person wants to know: which thread, what
 * happened, and where to go.
 *
 * STUB: written by the lead so the tests compile. The executor replaces the
 * function bodies; exported names, types, and signatures must not change.
 */
import type { MessageId, ThreadId } from "@t3tools/contracts";

/** Message ids the server gives its automatic follow-through turns. */
export const DELEGATION_NOTICE_MESSAGE_PREFIX = "delegation-follow-through:";

export type DelegationNoticeStatus =
  | "completed"
  | "needs-approval"
  | "needs-input"
  | "interrupted"
  | "error";

export interface DelegationNoticeUpdate {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly status: DelegationNoticeStatus;
  /** One line explaining a failure, when the server sent one. */
  readonly reason: string | null;
  /** True for a pair executor, false for a fan-out child. */
  readonly isExecutor: boolean;
}

export interface DelegationNotice {
  readonly updates: ReadonlyArray<DelegationNoticeUpdate>;
  /** Whether any update is waiting on the user rather than reporting a result. */
  readonly needsUser: boolean;
}

/**
 * The notice a message carries, or null for every ordinary message. Only a
 * user-role message with the server's id prefix is ever parsed, so a person who
 * pastes similar text still sees their own words.
 */
export function parseDelegationNotice(_message: {
  readonly id: MessageId;
  readonly role: string;
  readonly text: string;
}): DelegationNotice | null {
  throw new Error("state/delegationNotice.parseDelegationNotice is not implemented");
}

/** "Executor finished", "Delegated thread needs your approval", and so on. */
export function delegationNoticeHeadline(_update: DelegationNoticeUpdate): string {
  throw new Error("state/delegationNotice.delegationNoticeHeadline is not implemented");
}

/** One line for the whole notice: the headline of one update, or a count. */
export function delegationNoticeSummary(_notice: DelegationNotice): string {
  throw new Error("state/delegationNotice.delegationNoticeSummary is not implemented");
}
