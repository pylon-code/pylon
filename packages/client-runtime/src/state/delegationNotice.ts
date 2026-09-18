/**
 * The automatic message Pylon sends a parent when its delegated work changes
 * state is written for the agent: a preamble, one JSON line per child, and a
 * paragraph of rules. Shown raw, it reads as a wall of JSON in the user's own
 * voice. This turns it into what a person wants to know: which thread, what
 * happened, and where to go.
 */
import { ThreadId, type MessageId } from "@t3tools/contracts";
import { isPairExecutorThreadId } from "@t3tools/shared/delegatedThreads";

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

function isValidStatus(status: unknown): status is DelegationNoticeStatus {
  return (
    status === "completed" ||
    status === "needs-approval" ||
    status === "needs-input" ||
    status === "interrupted" ||
    status === "error"
  );
}

/**
 * The notice a message carries, or null for every ordinary message. Only a
 * user-role message with the server's id prefix is ever parsed, so a person who
 * pastes similar text still sees their own words.
 */
export function parseDelegationNotice(message: {
  readonly id: MessageId;
  readonly role: string;
  readonly text: string;
}): DelegationNotice | null {
  if (message.role !== "user" || !message.id.startsWith(DELEGATION_NOTICE_MESSAGE_PREFIX)) {
    return null;
  }

  const lines = message.text.split("\n");
  const updates: DelegationNoticeUpdate[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "threadId" in parsed &&
      typeof parsed.threadId === "string" &&
      parsed.threadId.length > 0 &&
      "title" in parsed &&
      typeof parsed.title === "string" &&
      "status" in parsed &&
      isValidStatus(parsed.status)
    ) {
      let reason: string | null = null;
      if ("reason" in parsed && typeof parsed.reason === "string") {
        const collapsed = parsed.reason.replace(/\s+/g, " ").trim();
        reason = collapsed.length > 0 ? collapsed : null;
      }
      const threadId = ThreadId.make(parsed.threadId);
      const isExecutor = isPairExecutorThreadId(threadId);
      updates.push({
        threadId,
        title: parsed.title,
        status: parsed.status,
        reason,
        isExecutor,
      });
    }
  }

  if (updates.length === 0) {
    return null;
  }

  const needsUser = updates.some(
    (update) => update.status === "needs-approval" || update.status === "needs-input",
  );

  return {
    updates,
    needsUser,
  };
}

/** \"Executor finished\", \"Delegated thread needs your approval\", and so on. */
export function delegationNoticeHeadline(update: DelegationNoticeUpdate): string {
  const subject = update.isExecutor ? "Executor" : "Delegated thread";
  let verb: string;
  switch (update.status) {
    case "completed":
      verb = "finished";
      break;
    case "needs-approval":
      verb = "needs your approval";
      break;
    case "needs-input":
      verb = "has a question";
      break;
    case "interrupted":
      verb = "was stopped";
      break;
    case "error":
      verb = "failed";
      break;
  }
  return `${subject} ${verb}`;
}

/** One line for the whole notice: the headline of one update, or a count. */
export function delegationNoticeSummary(notice: DelegationNotice): string {
  if (notice.updates.length === 1 && notice.updates[0] !== undefined) {
    return delegationNoticeHeadline(notice.updates[0]);
  }
  return `${notice.updates.length} delegated updates`;
}
