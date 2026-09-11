import type { QueuedThreadMessage } from "./thread-outbox-model";
import { scopedThreadKey } from "../lib/scopedEntities";
import { pendingTaskDraftKey, restoredNewTaskDraftKey } from "./new-task-draft-key";
import {
  appendComposerDraftAttachments,
  clearComposerDraftContent,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  isComposerDraftEmpty,
  mergeComposerDraftContent,
  replaceComposerDraftAttachments,
  setComposerDraftText,
  updateComposerDraftSettings,
} from "./use-composer-drafts";

/**
 * Seeds a queued new task's editor draft from the message. Only a fresh
 * editing draft is filled; reopening mid-edit keeps the newer edits.
 */
export function hydratePendingTaskEditorDraft(message: QueuedThreadMessage): void {
  const creation = message.creation;
  if (!creation) return;
  const draftKey = pendingTaskDraftKey(message.messageId);
  if (!isComposerDraftEmpty(getComposerDraftSnapshot(draftKey))) return;
  setComposerDraftText(draftKey, message.text);
  replaceComposerDraftAttachments(draftKey, message.attachments);
  updateComposerDraftSettings(draftKey, {
    modelSelection: message.modelSelection,
    providerSelectionExplicit: message.modelSelection !== undefined,
    runtimeMode: message.runtimeMode,
    interactionMode: message.interactionMode,
    workspaceSelection: {
      mode: creation.workspaceMode,
      branch: creation.branch,
      worktreePath: creation.worktreePath,
      startFromOrigin: creation.startFromOrigin ?? false,
    },
  });
}

/** Moves what was typed on the thread screen during setup into `targetKey`. */
async function moveSetupEdits(message: QueuedThreadMessage, targetKey: string): Promise<void> {
  const sourceKey = scopedThreadKey(message.environmentId, message.threadId);
  const source = getComposerDraftSnapshot(sourceKey);
  await mergeComposerDraftContent(targetKey, { text: source.text, attachments: [] });
  const existingIds = new Set(
    getComposerDraftSnapshot(targetKey).attachments.map((attachment) => attachment.id),
  );
  appendComposerDraftAttachments(
    targetKey,
    source.attachments.filter((attachment) => !existingIds.has(attachment.id)),
    { allowOverflow: true },
  );
  // Recovery may exceed the send cap. Preserve every file and let the editor
  // ask the user to remove extras; never discard them during a failed send.
  await flushComposerDrafts();
  clearComposerDraftContent(sourceKey);
}

function hasSetupEdits(message: QueuedThreadMessage): boolean {
  const source = getComposerDraftSnapshot(scopedThreadKey(message.environmentId, message.threadId));
  return source.text.length > 0 || source.attachments.length > 0;
}

/** Move unsent setup edits into the restored task before reopening its editor. */
export async function recoverFailedThreadDraft(message: QueuedThreadMessage): Promise<void> {
  if (!hasSetupEdits(message)) return;
  await moveSetupEdits(message, restoredNewTaskDraftKey(message.messageId));
}

/**
 * A held creation stays queued, so its content opens in the pending-task
 * editor. Fill that editor from the message first, then add what was typed
 * on the thread screen during setup; the thread's own draft belongs to a
 * thread the server never created.
 */
export async function recoverHeldCreationDraft(message: QueuedThreadMessage): Promise<void> {
  if (!message.creation || !hasSetupEdits(message)) return;
  hydratePendingTaskEditorDraft(message);
  await moveSetupEdits(message, pendingTaskDraftKey(message.messageId));
}
