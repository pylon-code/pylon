import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type { ComposerThreadDraftState } from "../../composerDraftStore";
import { toKindScopedComposerContextId } from "../../lib/composerContextReferences";

type ImportDraft = Pick<ComposerThreadDraftState, "prompt" | "previewAnnotations">;

/** A removed pending chip stays cancelled even if undo later recreates the same text. */
export function trackPendingContextImport(input: {
  readonly kind: "image" | "file";
  readonly localId: string;
  readonly readDraft: () => ImportDraft | null | undefined;
  readonly subscribe: (changed: () => void) => () => void;
  readonly ownsTarget: () => boolean;
}) {
  const controller = new AbortController();
  let seenReference = false;
  let cancelled = false;
  const wanted = () => {
    const draft = input.readDraft();
    if (!draft) return false;
    const references = new Set(
      collectComposerContextReferences(draft.prompt).map((reference) => reference.contextId),
    );
    return (
      references.has(toKindScopedComposerContextId(input.kind, input.localId)) ||
      (input.kind === "image" &&
        draft.previewAnnotations.some(
          (annotation) =>
            annotation.id === input.localId &&
            references.has(toKindScopedComposerContextId("preview-annotation", annotation.id)),
        ))
    );
  };
  const observe = () => {
    const current = wanted();
    if ((seenReference && !current) || !input.ownsTarget()) {
      cancelled = true;
      controller.abort();
    }
    if (current) seenReference = true;
  };
  // Paste registers before its editor writes the new reference in the same turn.
  observe();
  const unsubscribe = input.subscribe(observe);
  return {
    signal: controller.signal,
    cancel: () => {
      cancelled = true;
      controller.abort();
    },
    canComplete: () => !cancelled && input.ownsTarget() && wanted(),
    dispose: unsubscribe,
  };
}
