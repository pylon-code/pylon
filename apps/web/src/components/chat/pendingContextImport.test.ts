import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  formatInlineContextReference,
  toKindScopedComposerContextId,
} from "../../lib/composerContextReferences";
import { trackPendingContextImport } from "./pendingContextImport";

const target = scopeThreadRef(EnvironmentId.make("pending-import"), ThreadId.make("draft"));
function track(kind: "image" | "file", id: string, ownsTarget = () => true) {
  const store = useComposerDraftStore.getState();
  store.clearComposerContent(target);
  return trackPendingContextImport({
    kind,
    localId: id,
    readDraft: () => store.getComposerDraft(target),
    subscribe: (changed) => useComposerDraftStore.subscribe(changed),
    ownsTarget,
  });
}
const reference = (kind: "file" | "image" | "preview-annotation", id: string) =>
  formatInlineContextReference({
    kind,
    contextId: toKindScopedComposerContextId(kind, id),
    label: id,
  });

describe("pending context import ownership", () => {
  it("cannot resurrect a file after its last chip is deleted or undone during a download", async () => {
    const ownership = track("file", "download");
    const store = useComposerDraftStore.getState();
    let finish!: () => void;
    const download = new Promise<void>((resolve) => {
      finish = resolve;
    }).then(() => ownership.canComplete());
    store.setPrompt(target, reference("file", "download"));
    expect(ownership.canComplete()).toBe(true);
    store.setPrompt(target, "new unsent prompt");
    store.setPrompt(target, reference("file", "download"));
    finish();
    expect(await download).toBe(false);
    ownership.dispose();
  });
  it("accepts a still-referenced file while allowing ordinary prose edits", () => {
    const ownership = track("file", "kept");
    useComposerDraftStore
      .getState()
      .setPrompt(target, `${reference("file", "kept")} with new prose`);
    expect(ownership.canComplete()).toBe(true);
    ownership.dispose();
  });
  it("cancels on same-target replacement and never revives on an old source epoch", () => {
    let sameEpoch = true;
    const ownership = track("image", "image", () => sameEpoch);
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, reference("image", "image"));
    sameEpoch = false;
    expect(ownership.canComplete()).toBe(false);
    store.clearComposerContent(target);
    sameEpoch = true;
    store.setPrompt(target, reference("image", "image"));
    expect(ownership.canComplete()).toBe(false);
    ownership.dispose();
  });
  it("rejects a completion from an unmounted composer after a replacement advances the live epoch", () => {
    const frozenComponent = { targetKey: "same-draft", sourceEpoch: 7 };
    const liveProjection = { targetKey: "same-draft", sourceEpoch: 7 };
    const ownership = track(
      "file",
      "unmounted",
      () =>
        frozenComponent.targetKey === liveProjection.targetKey &&
        frozenComponent.sourceEpoch === liveProjection.sourceEpoch,
    );
    useComposerDraftStore.getState().setPrompt(target, reference("file", "unmounted"));
    expect(ownership.canComplete()).toBe(true);
    // The abandoned component's refs remain frozen, and its download is still running.
    // A replacement has observed the authoritative rewind on the same thread.
    liveProjection.sourceEpoch = 8;
    expect(ownership.canComplete()).toBe(false);
    ownership.dispose();
  });
  it("retains dependent screenshots only while their annotation remains referenced", () => {
    const ownership = track("image", "annotation");
    const store = useComposerDraftStore.getState();
    store.addPreviewAnnotation(target, {
      id: "annotation",
      pageUrl: "http://localhost",
      pageTitle: null,
      comment: "fix",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-09-12T00:00:00Z",
    });
    expect(ownership.canComplete()).toBe(true);
    store.removePreviewAnnotation(target, "annotation");
    expect(ownership.canComplete()).toBe(false);
    ownership.dispose();
  });
});
