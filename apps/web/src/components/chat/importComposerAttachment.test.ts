import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  formatInlineContextReference,
  toKindScopedComposerContextId,
} from "../../lib/composerContextReferences";
import { fetchImportedComposerAttachment } from "./importComposerAttachment";
import { trackPendingContextImport } from "./pendingContextImport";
import { pendingDraftWork } from "./pendingDraftWork";

const originalConnection = { httpBaseUrl: "https://old.example" };
const success = (relativeUrl: string) => ({ _tag: "Success" as const, value: { relativeUrl } });
const attachment = { name: "notes.txt", mimeType: "text/plain" };

afterEach(() => vi.unstubAllGlobals());

describe("pasted attachment authorization and download", () => {
  for (const cancellation of [
    "remove chip",
    "unmount",
    "replace source epoch",
    "deadline",
  ] as const) {
    it(`releases pending draft work when ${cancellation} interrupts unresolved authorization`, async () => {
      const target = scopeThreadRef(
        EnvironmentId.make("import-cancellation"),
        ThreadId.make(cancellation),
      );
      const store = useComposerDraftStore.getState();
      store.clearComposerContent(target);
      let currentEpoch = true;
      const ownership = trackPendingContextImport({
        kind: "file",
        localId: "import",
        readDraft: () => store.getComposerDraft(target),
        subscribe: (changed) => useComposerDraftStore.subscribe(changed),
        ownsTarget: () => currentEpoch,
      });
      const reference = formatInlineContextReference({
        kind: "file",
        contextId: toKindScopedComposerContextId("file", "import"),
        label: "notes.txt",
      });
      store.setPrompt(target, reference);
      const deadline = new AbortController();
      const signal = AbortSignal.any([ownership.signal, deadline.signal]);
      const authorize = vi.fn(
        (operationSignal: AbortSignal) =>
          new Promise<ReturnType<typeof success>>((_resolve, reject) => {
            operationSignal.addEventListener("abort", () => reject(operationSignal.reason), {
              once: true,
            });
          }),
      );
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      pendingDraftWork.begin(cancellation);
      const transfer = fetchImportedComposerAttachment({
        ...attachment,
        signal,
        readConnection: () => originalConnection,
        authorize,
      }).finally(() => {
        ownership.dispose();
        pendingDraftWork.end(cancellation);
      });
      expect(pendingDraftWork.has(cancellation)).toBe(true);
      expect(authorize).toHaveBeenCalledWith(signal);
      const rejected = expect(transfer).rejects.toMatchObject({
        name: cancellation === "deadline" ? "TimeoutError" : "AbortError",
      });
      switch (cancellation) {
        case "remove chip":
          store.setPrompt(target, "new unsent prompt");
          break;
        case "unmount":
          ownership.cancel();
          break;
        case "replace source epoch":
          currentEpoch = false;
          store.setPrompt(target, `${reference} new prompt`);
          break;
        case "deadline":
          deadline.abort(new DOMException("Timed out", "TimeoutError"));
          break;
      }
      await rejected;
      expect(pendingDraftWork.has(cancellation)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it("discards a capability from an old connection and authorizes again before downloading", async () => {
    let current = originalConnection;
    const reconnected = { httpBaseUrl: "https://current.example" };
    const authorize = vi.fn(async () => {
      if (current === originalConnection) {
        current = reconnected;
        return success("/api/assets?capability=old");
      }
      return success("/api/assets?capability=current");
    });
    const fetch = vi.fn(async () => new Response("hello"));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const file = await fetchImportedComposerAttachment({
      ...attachment,
      signal,
      readConnection: () => current,
      authorize,
    });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://current.example/api/assets?capability=current",
      { signal },
    );
    expect(file.name).toBe("notes.txt");
    expect(await file.text()).toBe("hello");
  });

  it("fails without fetching when the connection changes during both authorization attempts", async () => {
    let current = originalConnection;
    const authorize = vi.fn(async () => {
      current = { httpBaseUrl: "https://moving.example" };
      return success("/api/assets?capability=stale");
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchImportedComposerAttachment({
        ...attachment,
        signal: new AbortController().signal,
        readConnection: () => current,
        authorize,
      }),
    ).rejects.toThrow("source environment changed");
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the same cancellation signal after authorization while bytes are downloading", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const downloading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
          started();
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const transfer = fetchImportedComposerAttachment({
      ...attachment,
      signal: controller.signal,
      readConnection: () => originalConnection,
      authorize: async () => success("/api/assets?capability=current"),
    });
    const rejected = expect(transfer).rejects.toMatchObject({ name: "AbortError" });
    await downloading;
    controller.abort();
    await rejected;
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://old.example/api/assets?capability=current",
      { signal: controller.signal },
    );
  });
});
