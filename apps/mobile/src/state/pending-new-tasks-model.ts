import type { EnvironmentId, ProjectId, ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { canUploadComposerAttachment } from "../lib/composerAttachmentUploadQueue";
import { deriveThreadTitleFromPrompt } from "../lib/projectThreadStartTurn";
import type { QueuedThreadCreation, QueuedThreadMessage } from "./thread-outbox-model";
import { isNewTaskDraftKey } from "./new-task-draft-key";
import type { ComposerDraft } from "./use-composer-drafts";

/**
 * Unsent work that will become a thread, shaped for thread-list presentation.
 * A `pending` task sits in the outbox and sends itself when its environment
 * reconnects; a `draft` is new-task composer content, which only sends when
 * the user submits it. Both share the list slot so the user can find
 * everything they have written but not yet started in one place.
 */
export type PendingNewTask = PendingQueuedTask | PendingDraftTask;

export interface PendingQueuedTask {
  readonly kind: "pending";
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string | undefined;
  readonly projectCwd: string | undefined;
  readonly branch: string | null;
  readonly title: string;
  readonly createdAt: string;
  readonly message: QueuedThreadMessage;
  readonly creation: QueuedThreadCreation;
}

export interface PendingDraftTask {
  readonly kind: "draft";
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: undefined;
  readonly projectCwd: undefined;
  readonly branch: string | null;
  readonly title: string;
  readonly createdAt: string;
  readonly draftKey: string;
  readonly draft: ComposerDraft;
}

/**
 * Settings-only drafts (a model pick with no text) are not work the user
 * would look for in the list; only text or attachments make a draft visible.
 */
export function composerDraftHasUserContent(draft: ComposerDraft): boolean {
  return draft.text.trim().length > 0 || draft.attachments.length > 0;
}

type DraftRecord = Readonly<Record<string, ComposerDraft>>;

function isListedNewTaskDraft(key: string, draft: ComposerDraft): boolean {
  return (
    isNewTaskDraftKey(key) && draft.project !== undefined && composerDraftHasUserContent(draft)
  );
}

/**
 * The new-task drafts the thread list shows. Returns `previous` when those
 * entries are unchanged, so typing in a thread composer (a different key) or
 * picking a model on an empty draft leaves the list's input untouched.
 */
export function selectListedNewTaskDrafts(
  drafts: DraftRecord,
  previous: DraftRecord | undefined,
): DraftRecord {
  const listed: Record<string, ComposerDraft> = {};
  let count = 0;
  let changed = previous === undefined;
  for (const [key, draft] of Object.entries(drafts)) {
    if (!isListedNewTaskDraft(key, draft)) continue;
    listed[key] = draft;
    count += 1;
    if (previous !== undefined && previous[key] !== draft) changed = true;
  }
  if (!changed && previous !== undefined && Object.keys(previous).length === count) {
    return previous;
  }
  return listed;
}

/** Derives the listed drafts from the whole draft store without re-notifying on unrelated edits. */
export function makeListedNewTaskDraftsAtom(
  source: Atom.Atom<DraftRecord>,
): Atom.Atom<DraftRecord> {
  return Atom.make((get) =>
    selectListedNewTaskDrafts(get(source), Option.getOrUndefined(get.self<DraftRecord>())),
  );
}

/** What happens next to a queued task, as this device sees it. */
export type PendingTaskDelivery = "held" | "offline" | "uploading" | "sending";

export function resolvePendingTaskDelivery(input: {
  readonly message: QueuedThreadMessage;
  readonly connected: boolean;
  readonly serverConfig: Pick<ServerConfig, "environment"> | null | undefined;
}): PendingTaskDelivery {
  const { message } = input;
  if (message.deliveryHold !== undefined) return "held";
  if (!input.connected) return "offline";
  // The drain uploads files the server has not received before it sends.
  const awaitingUpload = message.attachments.some(
    (attachment) =>
      canUploadComposerAttachment(attachment, input.serverConfig) &&
      (attachment.uploadedAttachmentId === undefined ||
        attachment.uploadEnvironmentId !== message.environmentId),
  );
  return awaitingUpload ? "uploading" : "sending";
}

export const PENDING_TASK_DELIVERY_PRESENTATION: Readonly<
  Record<PendingTaskDelivery, { readonly label: string; readonly accessibilityHint: string }>
> = {
  held: { label: "Held", accessibilityHint: "Held until retargeted. Opens the task for editing" },
  offline: {
    label: "Sends on reconnect",
    accessibilityHint: "Sends when the environment reconnects. Opens the task for editing",
  },
  uploading: {
    label: "Waiting for upload",
    accessibilityHint: "Sends after its attachments upload. Opens the task for editing",
  },
  sending: { label: "Sending…", accessibilityHint: "Sending now. Opens the task for editing" },
};

function draftTitle(draft: ComposerDraft): string {
  if (draft.text.trim().length > 0) {
    return deriveThreadTitleFromPrompt(draft.text);
  }
  const count = draft.attachments.length;
  return count === 1 ? "1 attachment" : `${count} attachments`;
}

export function buildPendingNewTasks(input: {
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly drafts: Readonly<Record<string, ComposerDraft>>;
}): ReadonlyArray<PendingNewTask> {
  const tasks: PendingNewTask[] = [];
  for (const message of input.queuedMessages) {
    if (!message.creation) {
      continue;
    }
    tasks.push({
      kind: "pending",
      key: `pending-task:${message.messageId}`,
      environmentId: message.environmentId,
      projectId: message.creation.projectId,
      projectTitle: message.creation.projectTitle,
      projectCwd: message.creation.projectCwd,
      branch: message.creation.branch,
      title: deriveThreadTitleFromPrompt(message.text),
      createdAt: message.createdAt,
      message,
      creation: message.creation,
    });
  }
  for (const [draftKey, draft] of Object.entries(input.drafts)) {
    if (!isListedNewTaskDraft(draftKey, draft) || !draft.project) {
      continue;
    }
    tasks.push({
      kind: "draft",
      key: `draft-task:${draftKey}`,
      environmentId: draft.project.environmentId,
      projectId: draft.project.projectId,
      projectTitle: undefined,
      projectCwd: undefined,
      branch: draft.workspaceSelection?.branch ?? null,
      title: draftTitle(draft),
      createdAt: draft.project.createdAt,
      draftKey,
      draft,
    });
  }
  // Drafts are what the user is writing now, so they lead; within each kind,
  // newest first.
  tasks.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "draft" ? -1 : 1;
    }
    return right.createdAt.localeCompare(left.createdAt) || left.key.localeCompare(right.key);
  });
  return tasks;
}
