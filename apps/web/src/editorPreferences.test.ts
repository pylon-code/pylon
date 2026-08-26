import { describe, expect, it } from "vite-plus/test";

import { resolvePreferredEditorTargetPath } from "./editorPreferences";

describe("resolvePreferredEditorTargetPath", () => {
  it("drops editor position metadata for the file manager", () => {
    expect(
      resolvePreferredEditorTargetPath(
        "file-manager",
        "/work/repo/src/main.ts:42:7",
        "/work/repo/src/main.ts",
      ),
    ).toBe("/work/repo/src/main.ts");
  });

  it("preserves editor position metadata for code editors", () => {
    expect(
      resolvePreferredEditorTargetPath(
        "cursor",
        "/work/repo/src/main.ts:42:7",
        "/work/repo/src/main.ts",
      ),
    ).toBe("/work/repo/src/main.ts:42:7");
  });

  it("keeps existing file-manager callers unchanged when no alternate target is provided", () => {
    expect(resolvePreferredEditorTargetPath("file-manager", "/work/repo/src/main.ts")).toBe(
      "/work/repo/src/main.ts",
    );
  });
});
