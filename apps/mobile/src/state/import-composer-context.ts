import {
  importComposerContextClipboard,
  type NativeContextClipboard,
} from "../lib/composerContextClipboard";
import { removePersistedComposerAttachmentFile } from "../lib/composerImages";
import { reidentifyComposerContext } from "../lib/composerContext";
import { uuidv4 } from "../lib/uuid";
import {
  appendComposerDraftAttachments,
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  sameComposerDraftState,
} from "./use-composer-drafts";

export const COMPOSER_CONTEXT_IMPORT_TIMEOUT_MS = 30_000;

/** Bound the whole operation, including a source awaiting reconnection, without losing late-file ownership. */
export async function importComposerContextIntoDraft(
  draftKey: string,
  clipboard: NativeContextClipboard,
  signal: AbortSignal,
) {
  const controller = new AbortController();
  let resolveCancellation: (() => void) | undefined;
  const cancelled = new Promise<{ status: "stale" }>((resolve) => {
    resolveCancellation = () => resolve({ status: "stale" });
  });
  const abort = () => {
    controller.abort();
    resolveCancellation?.();
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error(
    "Copying context timed out. Reconnect to the source environment and paste again.",
  );
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError);
    }, COMPOSER_CONTEXT_IMPORT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      importComposerContextIntoDraftSnapshot(draftKey, clipboard, controller.signal),
      deadline,
      cancelled,
    ]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    if (signal.aborted) return { status: "stale" as const };
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** A late completion still owns its downloaded bytes and checks cancellation before any draft write. */
async function importComposerContextIntoDraftSnapshot(
  draftKey: string,
  clipboard: NativeContextClipboard,
  signal: AbortSignal,
) {
  const snapshot = getComposerDraftSnapshot(draftKey);
  const result = await importComposerContextClipboard(
    clipboard,
    snapshot.attachments.length,
    signal,
    snapshot.context?.records.length ?? 0,
  );
  if (signal.aborted || !sameComposerDraftState(snapshot, getComposerDraftSnapshot(draftKey))) {
    await Promise.all(
      (result?.attachments ?? []).map((attachment) =>
        attachment.fileUri
          ? removePersistedComposerAttachmentFile(attachment.fileUri)
          : Promise.resolve(),
      ),
    );
    return { status: "stale" as const };
  }
  if (!result) {
    insertComposerDraftContext(draftKey, reidentifyComposerContext(clipboard.text, [], uuidv4));
    return { status: "applied" as const, unavailable: false };
  }
  const rejected = appendComposerDraftAttachments(draftKey, result.attachments);
  const ids = new Set(
    getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
  );
  insertComposerDraftContext(draftKey, {
    text: result.text,
    context: {
      version: 1,
      records: result.context.records.filter(
        (record) => !("attachmentId" in record) || ids.has(record.attachmentId),
      ),
    },
  });
  return { status: "applied" as const, unavailable: result.failures.length > 0 || rejected > 0 };
}
