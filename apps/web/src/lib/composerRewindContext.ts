import type { ThreadId } from "@t3tools/contracts";
import type { ChatMessage } from "../types";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { editableComposerPrompt } from "../components/chat/composerPromptHistory";
import {
  asKnownContextRecord,
  previewAnnotationContextReference,
  previewAnnotationFromRecord,
  resolveUserMessageContext,
  reviewCommentContextReference,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
  terminalContextReference,
} from "./composerContextRecords";
import { elementContextToPreviewAnnotation } from "./elementContext";
import {
  formatInlineContextReference,
  toKindScopedComposerContextId,
} from "./composerContextReferences";
import type { TerminalContextDraft } from "./terminalContext";

/** Prepare a fresh draft snapshot before admitting the destructive rewind. */
export function prepareRevertedMessageContext(input: {
  readonly message: Pick<ChatMessage, "text" | "context" | "attachments">;
  readonly threadId: ThreadId;
  readonly attachmentIds: ReadonlyMap<string, string>;
  readonly newId: () => string;
}) {
  const resolved = resolveUserMessageContext(input.message);
  const references = new Map<string, { kind: string; contextId: string }>();
  const inlineSyntax = new Map<string, string>();
  const terminalContexts: TerminalContextDraft[] = [];
  const reviewComments: ReviewCommentContext[] = [];
  const previewAnnotations: PreviewAnnotationPayload[] = [];
  for (const candidate of resolved.records) {
    const record = asKnownContextRecord(candidate);
    if (!record) throw new Error("This message has context that this client cannot restore.");
    switch (record.kind) {
      case "mention":
        inlineSyntax.set(record.contextId, serializeComposerFileLink(record.path));
        break;
      case "skill":
        inlineSyntax.set(record.contextId, `$${record.name}`);
        break;
      case "terminal": {
        const context = {
          ...terminalContextDraftFromRecord(record, input.threadId),
          id: input.newId(),
        };
        terminalContexts.push(context);
        references.set(record.contextId, terminalContextReference(context));
        break;
      }
      case "review-comment": {
        const comment = { ...reviewCommentFromRecord(record), id: input.newId() };
        reviewComments.push(comment);
        references.set(record.contextId, reviewCommentContextReference(comment));
        break;
      }
      case "element":
      case "preview-annotation": {
        const screenshotRecord =
          record.kind === "preview-annotation" && record.screenshotContextId
            ? asKnownContextRecord(resolved.recordsById.get(record.screenshotContextId))
            : undefined;
        const legacyScreenshot =
          record.kind === "preview-annotation"
            ? input.message.attachments?.find(
                (attachment) =>
                  attachment.type === "image" &&
                  attachment.name === `preview-annotation-${record.annotationId}.png`,
              )
            : undefined;
        const screenshotId =
          screenshotRecord?.kind === "image"
            ? input.attachmentIds.get(screenshotRecord.attachmentId)
            : legacyScreenshot
              ? input.attachmentIds.get(legacyScreenshot.id)
              : undefined;
        const annotation =
          record.kind === "element"
            ? elementContextToPreviewAnnotation(record, input.newId(), new Date().toISOString())
            : { ...previewAnnotationFromRecord(record), id: screenshotId ?? input.newId() };
        previewAnnotations.push(annotation);
        references.set(record.contextId, previewAnnotationContextReference(annotation));
        break;
      }
      case "image":
      case "file": {
        const localId = input.attachmentIds.get(record.attachmentId);
        if (!localId) throw new Error(`The attachment for ${record.label} is no longer available.`);
        references.set(record.contextId, {
          kind: record.kind,
          contextId: toKindScopedComposerContextId(record.kind, localId),
        });
        break;
      }
    }
  }
  const prompt = replaceComposerContextReferences(
    editableComposerPrompt(resolved.text),
    (reference) => {
      const syntax = inlineSyntax.get(reference.contextId);
      if (syntax !== undefined) return syntax;
      const restored = references.get(reference.contextId);
      return restored
        ? formatInlineContextReference({ ...reference, ...restored })
        : reference.source;
    },
  );
  return { prompt, terminalContexts, reviewComments, previewAnnotations };
}
