import { describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { recoverPendingSendToComposer } from "./thread-outbox-recovery";
import type { QueuedThreadMessage } from "./thread-outbox-model";

function heldMessage(): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-held"),
    commandId: CommandId.make("command-held"),
    text: "exact held text",
    attachments: [
      {
        id: "held-image",
        previewUri: "file:///held.png",
        type: "image",
        name: "held.png",
        mimeType: "image/png",
        sizeBytes: 12,
        dataUrl: "data:image/png;base64,AQ==",
      },
    ],
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    deliveryHold: {
      kind: "provider-binding-mismatch",
      reason: "Choose a destination.",
    },
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("pending send composer recovery", () => {
  it("durably flushes the exact payload before CAS-removing the queue item", async () => {
    const message = heldMessage();
    const order: string[] = [];
    const restore = vi.fn((draftKey: string, snapshot: unknown) => {
      order.push(`restore:${draftKey}`);
      expect(snapshot).toEqual({
        text: message.text,
        attachments: message.attachments,
        modelSelection: message.modelSelection,
        runtimeMode: message.runtimeMode,
        interactionMode: message.interactionMode,
      });
    });
    const flushDraft = vi.fn(async () => {
      order.push("flush");
    });
    const removeIfCurrent = vi.fn(async (candidate: QueuedThreadMessage) => {
      order.push("remove");
      expect(candidate).toBe(message);
      return true;
    });

    await expect(
      recoverPendingSendToComposer(
        { message, draftKey: "environment-1:thread-1" },
        { restore, flushDraft, removeIfCurrent },
      ),
    ).resolves.toBe("removed");
    expect(order).toEqual(["restore:environment-1:thread-1", "flush", "remove"]);
  });

  it("keeps the queue item when the durable draft flush fails", async () => {
    const message = heldMessage();
    const flushError = new Error("draft disk full");
    const removeIfCurrent = vi.fn(async () => true);

    await expect(
      recoverPendingSendToComposer(
        { message, draftKey: "environment-1:thread-1" },
        {
          restore: () => {},
          flushDraft: async () => {
            throw flushError;
          },
          removeIfCurrent,
        },
      ),
    ).rejects.toBe(flushError);
    expect(removeIfCurrent).not.toHaveBeenCalled();
  });

  it("reports a concurrent queue CAS loss without deleting the newer item", async () => {
    const message = heldMessage();
    const removeIfCurrent = vi.fn(async () => false);

    await expect(
      recoverPendingSendToComposer(
        { message, draftKey: "environment-1:thread-1" },
        { restore: () => {}, flushDraft: async () => {}, removeIfCurrent },
      ),
    ).resolves.toBe("queue-changed");
    expect(removeIfCurrent).toHaveBeenCalledWith(message);
  });
});
