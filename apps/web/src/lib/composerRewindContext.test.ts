import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type ComposerContextRecord, type ComposerContextId } from "@t3tools/contracts";
import { prepareRevertedMessageContext } from "./composerRewindContext";
import {
  buildMessageContext,
  previewAnnotationContextRecord,
  terminalContextRecord,
  reviewCommentContextRecord,
} from "./composerContextRecords";
import {
  formatInlineContextReference,
  toKindScopedComposerContextId,
} from "./composerContextReferences";
import { recallableComposerPrompt } from "../components/chat/composerPromptHistory";

const threadId = ThreadId.make("rewind");
const terminal = terminalContextRecord({
  id: "term",
  threadId,
  createdAt: "2026-09-12T00:00:00Z",
  terminalId: "terminal",
  terminalLabel: "Shell",
  lineStart: 1,
  lineEnd: 2,
  text: "failing test",
});
const review = reviewCommentContextRecord({
  id: "review",
  sectionId: "src/app.ts",
  sectionTitle: "App",
  filePath: "src/app.ts",
  startIndex: 0,
  endIndex: 1,
  rangeLabel: "L1",
  text: "fix this",
  diff: "+ broken",
});
const annotation = previewAnnotationContextRecord(
  {
    id: "annotation",
    pageUrl: "http://localhost",
    pageTitle: "Preview",
    comment: "fix button",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: "2026-09-12T00:00:00Z",
  },
  { screenshotContextId: "screenshot" },
);
const screenshot = {
  version: 1,
  kind: "image",
  contextId: toKindScopedComposerContextId("image", "screenshot"),
  label: "Screenshot",
  attachmentId: "saved-image",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 1,
} as const;
const file = {
  version: 1,
  kind: "file",
  contextId: toKindScopedComposerContextId("file", "file"),
  label: "Notes",
  attachmentId: "saved-file",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 1,
} as const;
const link = (record: ComposerContextRecord) => formatInlineContextReference(record);
const prepare = (records: readonly ComposerContextRecord[], text = records.map(link).join(" ")) => {
  let counter = 0;
  return prepareRevertedMessageContext({
    message: { text, context: { version: 1, records } },
    threadId,
    attachmentIds: new Map([
      ["saved-image", "fresh-image"],
      ["saved-file", "fresh-file"],
    ]),
    newId: () => `fresh-${++counter}`,
  });
};
describe("rewound message context", () => {
  it("rebinds every context and annotation screenshot to fresh draft IDs while keeping prose and order", () => {
    const restored = prepare(
      [terminal, review, annotation, screenshot, file],
      `Before ${link(review)} between ${link(annotation)} ${link(file)} after ${link(terminal)}`,
    );
    expect(restored.terminalContexts[0]).toMatchObject({
      text: "failing test",
      threadId,
      id: "fresh-1",
    });
    expect(restored.reviewComments[0]).toMatchObject({
      id: "fresh-2",
      text: "fix this",
      diff: "+ broken",
    });
    expect(restored.previewAnnotations[0]).toMatchObject({
      id: "fresh-image",
      comment: "fix button",
    });
    expect(restored.prompt).toContain("review-comment_fresh-2");
    expect(restored.prompt).toContain("preview-annotation_fresh-image");
    expect(restored.prompt).toContain("file_fresh-file");
    expect(restored.prompt).toMatch(/^Before .* between .* after /);
    const resent = buildMessageContext({
      ...restored,
      attachments: [
        {
          attachment: {
            type: "image",
            id: "fresh-image",
            previewUrl: "data:image/png;base64,AA==",
            file: new File(["x"], "screen.png", { type: "image/png" }),
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 1,
          },
          attachmentId: "new-upload",
        },
      ],
    });
    expect(resent?.records).toContainEqual(
      expect.objectContaining({
        kind: "preview-annotation",
        screenshotContextId: "image_fresh-image",
      }),
    );
    expect(recallableComposerPrompt(restored.prompt)).toBe("Before between after");
  });
  it("restores known mention and skill records as supported composer syntax", () => {
    const restored = prepare([
      {
        version: 1,
        kind: "mention",
        contextId: "mention" as ComposerContextId,
        label: "File",
        path: "src/app.ts",
      },
      {
        version: 1,
        kind: "skill",
        contextId: "skill" as ComposerContextId,
        label: "Skill",
        name: "review",
      },
    ]);
    expect(restored.prompt).toBe("[app.ts](src/app.ts) $review");
  });
  it("fails before rewind admission when a context payload or attachment cannot be restored", () => {
    expect(() =>
      prepare([
        {
          version: 1,
          kind: "future",
          contextId: "future" as ComposerContextId,
          label: "Future",
          payload: {},
        },
      ]),
    ).toThrow("cannot restore");
    expect(() => prepare([{ ...file, attachmentId: "missing" }])).toThrow("no longer available");
  });
});
