import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  module: null as null | { textPasteAttachmentRevision?: number },
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => native.module }));

import { supportsNativePastedTextAttachments } from "./composerPasteCapability";

describe("installed composer native paste capability", () => {
  beforeEach(() => {
    native.module = null;
  });

  it("keeps an old installed binary on ordinary native paste", () => {
    expect(supportsNativePastedTextAttachments()).toBe(false);
    native.module = {};
    expect(supportsNativePastedTextAttachments()).toBe(false);
  });

  it("enables interception only for the matching native revision", () => {
    native.module = { textPasteAttachmentRevision: 1 };
    expect(supportsNativePastedTextAttachments()).toBe(true);
    native.module = { textPasteAttachmentRevision: 2 };
    expect(supportsNativePastedTextAttachments()).toBe(false);
  });
});
