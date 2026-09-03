import {
  CheckpointRef,
  MessageId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationMessage,
  type OrchestrationRollbackStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRollbackConfirmation,
  deriveRollbackTargets,
  formatRollbackTargetLabel,
  isRollbackActive,
} from "./rollback.ts";

const createdAt = "2026-04-01T00:00:00.000Z";
const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  turnId: string | null,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: turnId === null ? null : TurnId.make(turnId),
  streaming: false,
  createdAt,
  updatedAt: createdAt,
});
const checkpoint = (
  revision: number,
  assistantMessageId: string | null,
  state: "available" | "unavailable",
): OrchestrationCheckpointSummary => ({
  turnId: TurnId.make(`turn-${revision}`),
  checkpointTurnCount: revision,
  checkpointRef: CheckpointRef.make(`checkpoint-${revision}`),
  status: "ready",
  files: [],
  assistantMessageId: assistantMessageId === null ? null : MessageId.make(assistantMessageId),
  rollbackAvailability: {
    state,
    reason: state === "available" ? "Exact target verified." : "Exact target unavailable.",
  },
  completedAt: createdAt,
});

describe("exact rollback client model", () => {
  it("derives only message targets backed by a server-proven exact checkpoint", () => {
    const targets = deriveRollbackTargets({
      messages: [
        message("user-1", "user", "Keep this request", null),
        message("assistant-1", "assistant", "First response", "turn-1"),
        message("user-2", "user", "Do not offer this target", null),
        message("assistant-2", "assistant", "Second response", "turn-2"),
        message("user-3", "user", "Current request", null),
        message("assistant-3", "assistant", "Current response", "turn-3"),
      ],
      checkpoints: [
        checkpoint(0, null, "available"),
        checkpoint(1, "assistant-1", "unavailable"),
        checkpoint(2, "assistant-2", "available"),
        checkpoint(3, "assistant-3", "available"),
      ],
    });

    expect([...targets]).toEqual([
      [
        MessageId.make("user-1"),
        {
          messageId: MessageId.make("user-1"),
          targetTurnCount: 0,
          expectedSourceRevision: 3,
          label: "your message “Keep this request”",
        },
      ],
      [
        MessageId.make("user-3"),
        {
          messageId: MessageId.make("user-3"),
          targetTurnCount: 2,
          expectedSourceRevision: 3,
          label: "your message “Current request”",
        },
      ],
    ]);
  });

  it("does not infer eligibility from a ready checkpoint when proof is absent", () => {
    const target = checkpoint(0, null, "available");
    const { rollbackAvailability: _proof, ...legacyTarget } = target;
    expect(
      deriveRollbackTargets({
        messages: [
          message("user-1", "user", "Request", null),
          message("assistant-1", "assistant", "Response", "turn-1"),
        ],
        checkpoints: [legacyTarget, checkpoint(1, "assistant-1", "available")],
      }).size,
    ).toBe(0);
  });

  it("uses exact destructive confirmation copy on every client", () => {
    expect(buildRollbackConfirmation("your message “Keep this request”")).toBe(
      [
        "Revert to your message “Keep this request”?",
        "This rewrites the provider conversation, Pylon history, the worktree, the Git index, staged and unstaged changes, and untracked files to that point.",
        "Newer history is retained until the rollback commits.",
      ].join("\n\n"),
    );
  });

  it("keeps every nonterminal safety fence active", () => {
    const status = (state: OrchestrationRollbackStatus["state"]): OrchestrationRollbackStatus => ({
      state,
      updatedAt: createdAt,
    });
    expect(
      ["pending", "recovering", "manual-recovery"].map((state) =>
        isRollbackActive(status(state as OrchestrationRollbackStatus["state"])),
      ),
    ).toEqual([true, true, true]);
    expect(isRollbackActive(status("completed"))).toBe(false);
    expect(isRollbackActive(status("failed"))).toBe(false);
    expect(isRollbackActive(null)).toBe(false);
  });

  it("uses a readable bounded message label", () => {
    const label = formatRollbackTargetLabel(
      message("user-long", "user", `  ${"x".repeat(90)}  `, null),
    );
    expect(label).toBe(`your message “${"x".repeat(71)}…”`);
  });
});
