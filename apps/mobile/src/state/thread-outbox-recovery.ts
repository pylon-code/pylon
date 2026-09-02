import type { QueuedThreadMessage } from "./thread-outbox-model";
import {
  flushComposerDrafts,
  restorePendingSendComposerDraft,
  type ComposerDraftWorkspaceSelection,
  type PendingSendComposerSnapshot,
} from "./use-composer-drafts";
import { removeThreadOutboxMessageIfCurrent } from "./thread-outbox-removal";

export type PendingSendRecoveryResult = "removed" | "queue-changed";

export function pendingSendComposerSnapshot(
  message: QueuedThreadMessage,
  workspaceSelection?: ComposerDraftWorkspaceSelection,
): PendingSendComposerSnapshot {
  return {
    text: message.text,
    attachments: message.attachments,
    ...(message.modelSelection === undefined ? {} : { modelSelection: message.modelSelection }),
    ...(message.runtimeMode === undefined ? {} : { runtimeMode: message.runtimeMode }),
    ...(message.interactionMode === undefined ? {} : { interactionMode: message.interactionMode }),
    ...(workspaceSelection === undefined ? {} : { workspaceSelection }),
  };
}

/**
 * Recovery protocol for a held send:
 * 1. merge its exact payload and selection into the chosen composer;
 * 2. force that composer snapshot to durable storage;
 * 3. CAS-remove only the queue object the user opened.
 *
 * A crash or flush failure before step 3 leaves the original held item intact.
 * A concurrent retry makes step 3 return `queue-changed`, so the newer queued
 * item survives while the restored composer copy remains available to edit.
 */
export async function recoverPendingSendToComposer(
  input: {
    readonly message: QueuedThreadMessage;
    readonly draftKey: string;
    readonly workspaceSelection?: ComposerDraftWorkspaceSelection;
  },
  dependencies: {
    readonly restore: (draftKey: string, snapshot: PendingSendComposerSnapshot) => void;
    readonly flushDraft: () => Promise<void>;
    readonly removeIfCurrent: (message: QueuedThreadMessage) => Promise<boolean>;
  } = {
    restore: restorePendingSendComposerDraft,
    flushDraft: flushComposerDrafts,
    removeIfCurrent: removeThreadOutboxMessageIfCurrent,
  },
): Promise<PendingSendRecoveryResult> {
  dependencies.restore(
    input.draftKey,
    pendingSendComposerSnapshot(input.message, input.workspaceSelection),
  );
  await dependencies.flushDraft();
  return (await dependencies.removeIfCurrent(input.message)) ? "removed" : "queue-changed";
}
