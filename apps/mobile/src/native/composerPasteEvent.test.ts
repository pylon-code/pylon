import { describe, expect, it } from "vite-plus/test";
import { hasVersionedComposerPasteContext } from "./composerPasteEvent";

describe("native context paste across installed binary versions", () => {
  it("keeps legacy context clipboard payloads on their existing import path", () => {
    expect(hasVersionedComposerPasteContext({ text: "hello", fragment: "{}", html: "" })).toBe(false);
  });

  it("accepts a complete revisioned payload and rejects a partial one", () => {
    const base = { text: "hello", fragment: "{}", html: "", value: "before", eventCount: 4 };
    expect(hasVersionedComposerPasteContext({ ...base, selection: { start: 2, end: 2 } })).toBe(true);
    expect(hasVersionedComposerPasteContext({ ...base, selection: { start: 2 } })).toBe(false);
  });
});
