import type {
  MessageId,
  OrchestrationMessage,
  OrchestrationRollbackStatus,
  OrchestrationThread,
} from "@t3tools/contracts";

export interface RollbackTarget {
  readonly messageId: MessageId;
  readonly targetTurnCount: number;
  readonly expectedSourceRevision: number;
  readonly label: string;
}

export const EXACT_ROLLBACK_UNAVAILABLE_REASON =
  "Exact rollback requires an idle Pylon-managed native Prime session with a matching immutable checkpoint anchor.";

export function isRollbackActive(status: OrchestrationRollbackStatus | null | undefined): boolean {
  return (
    status?.state === "pending" ||
    status?.state === "recovering" ||
    status?.state === "manual-recovery"
  );
}

export function formatRollbackTargetLabel(message: OrchestrationMessage): string {
  const text = message.text.replace(/\s+/g, " ").trim();
  if (text.length === 0) return `your message from ${message.createdAt}`;
  const preview = text.length > 72 ? `${text.slice(0, 71)}…` : text;
  return `your message “${preview}”`;
}

export function deriveRollbackTargets(
  thread: Pick<OrchestrationThread, "messages" | "checkpoints">,
): ReadonlyMap<MessageId, RollbackTarget> {
  const sourceRevision = thread.checkpoints.reduce(
    (maximum, checkpoint) => Math.max(maximum, checkpoint.checkpointTurnCount),
    0,
  );
  const checkpointByAssistantMessage = new Map(
    thread.checkpoints.flatMap((checkpoint) =>
      checkpoint.assistantMessageId === null
        ? []
        : ([[checkpoint.assistantMessageId, checkpoint]] as const),
    ),
  );
  const checkpointByRevision = new Map(
    thread.checkpoints.map((checkpoint) => [checkpoint.checkpointTurnCount, checkpoint] as const),
  );
  const targets = new Map<MessageId, RollbackTarget>();

  for (let index = 0; index < thread.messages.length; index += 1) {
    const message = thread.messages[index];
    if (message?.role !== "user") continue;
    for (let nextIndex = index + 1; nextIndex < thread.messages.length; nextIndex += 1) {
      const next = thread.messages[nextIndex];
      if (!next || next.role === "user") break;
      const responseCheckpoint = checkpointByAssistantMessage.get(next.id);
      if (responseCheckpoint === undefined) continue;
      const targetTurnCount = Math.max(0, responseCheckpoint.checkpointTurnCount - 1);
      const targetCheckpoint = checkpointByRevision.get(targetTurnCount);
      if (
        targetCheckpoint?.status !== "ready" ||
        targetCheckpoint.rollbackAvailability?.state !== "available" ||
        targetTurnCount >= sourceRevision
      ) {
        break;
      }
      targets.set(message.id, {
        messageId: message.id,
        targetTurnCount,
        expectedSourceRevision: sourceRevision,
        label: formatRollbackTargetLabel(message),
      });
      break;
    }
  }
  return targets;
}

export function buildRollbackConfirmation(targetLabel: string): string {
  return [
    `Revert to ${targetLabel}?`,
    "This rewrites the provider conversation, Pylon history, the worktree, the Git index, staged and unstaged changes, and untracked files to that point.",
    "Newer history is retained until the rollback commits.",
  ].join("\n\n");
}
