import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { MarkdownTextPrimitiveProps } from "../../modules/t3-markdown-text/src/MarkdownTextPrimitive";

const native = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: (compute: () => unknown) => compute(),
  useCallback: (callback: unknown) => callback,
  useContext: () => "",
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android", select: (values: Record<string, unknown>) => values.android },
  StyleSheet: { create: (styles: unknown) => styles },
  useColorScheme: () => "light",
  findNodeHandle: () => 17,
  Text: "text",
  Image: "image",
  View: "view",
  Linking: { openURL: vi.fn() },
}));
vi.mock("../../modules/t3-markdown-text/src/MarkdownTextPrimitive", () => ({
  MarkdownTextPrimitive: "markdown-text",
}));
vi.mock("../../modules/t3-markdown-text/src/T3MarkdownTextSelectionModule", () => ({
  installMarkdownCopySanitizer: native.install,
  renderAndroidContextChip: () => ({
    uri: "data:image/png;base64,AQ==",
    width: 20,
    height: 20,
    boxHeight: 20,
    offsetY: 0,
  }),
}));
vi.mock("../../modules/t3-markdown-text/src/markdownFileIcons", () => ({
  markdownFileIconSource: () => null,
}));
vi.mock("../../modules/t3-markdown-text/src/markdownLinkIcons", () => ({
  markdownLinkIconSource: () => null,
}));

import { NativeMarkdownSelectableText } from "../../modules/t3-markdown-text/src/NativeMarkdownSelectableText";

const textStyle = {
  color: "black",
  strongColor: "black",
  mutedColor: "grey",
  linkColor: "blue",
  inlineCodeColor: "black",
  codeColor: "black",
  codeBackgroundColor: "white",
  codeBlockBackgroundColor: "white",
  fileTextColor: "black",
  skillTextColor: "black",
  quoteMarkerColor: "grey",
  dividerColor: "grey",
  fontSize: 15,
  lineHeight: 20,
  fontFamily: "sans",
  headingFontFamily: "sans",
  boldFontFamily: "sans",
};

describe("Android markdown copy ref updates", () => {
  it("clears old context ranges when the same paragraph changes from a chip to plain text", () => {
    const before = NativeMarkdownSelectableText({
      runs: [
        {
          text: "Build",
          href: "t3-context://v1/terminal/build",
          sourceText: "[Build](t3-context://v1/terminal/build)",
        },
      ],
      textStyle,
    }) as ReactElement<MarkdownTextPrimitiveProps>;
    const after = NativeMarkdownSelectableText({
      runs: [{ text: "new plain text" }],
      textStyle,
    }) as ReactElement<MarkdownTextPrimitiveProps>;
    expect(after.key).toBe(before.key);
    const view = {} as never;
    if (
      typeof before.props.nativeTextRef !== "function" ||
      typeof after.props.nativeTextRef !== "function"
    )
      throw new Error("Expected Android native text callback refs");
    before.props.nativeTextRef(view);
    after.props.nativeTextRef(view);
    expect(native.install).toHaveBeenCalledTimes(2);
    expect(JSON.parse(native.install.mock.calls[0]![1]).ranges).toHaveLength(1);
    expect(native.install).toHaveBeenLastCalledWith(17, "");
  });
});
