import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $copyNode, $getRoot, $isElementNode, PASTE_COMMAND, type LexicalEditor } from "lexical";
import { act, createRef } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { collapseExpandedComposerCursor } from "../composer-logic";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

vi.mock("./chat/FileTagChip", () => ({
  FILE_TAG_CHIP_CLASS_NAME: "",
  FileTagChipContent: () => null,
}));
vi.mock("./chat/ComposerPendingTerminalContexts", () => ({
  ComposerPendingTerminalContextChip: () => null,
}));
vi.mock("./chat/AssistantCitationChip", () => ({ AssistantCitationChip: () => null }));

let lexicalEditor: LexicalEditor;
// Keep the real composer, registered nodes, updates, and snapshot API. Only the
// DOM view is omitted so Lexical runs headlessly in this component test.
vi.mock("@lexical/react/LexicalPlainTextPlugin", () => ({
  PlainTextPlugin: function HeadlessEditor() {
    [lexicalEditor] = useLexicalComposerContext();
    return null;
  },
}));

let renderer: ReactTestRenderer | undefined;
const editorRef = createRef<ComposerPromptEditorHandle>();

function composer(value: string, allowUnicodeSkillAliases = true, registered = true) {
  return (
    <ComposerPromptEditor
      value={value}
      cursor={collapseExpandedComposerCursor(
        value,
        value.length,
        allowUnicodeSkillAliases,
        registered ? new Set(["review"]) : new Set(),
      )}
      contextRecords={new Map()}
      skills={[{ name: "review", path: "/skills/review/SKILL.md", enabled: registered }]}
      allowUnicodeSkillAliases={allowUnicodeSkillAliases}
      disabled={false}
      placeholder="Write a prompt"
      onChange={() => {}}
      onPaste={() => {}}
      editorRef={editorRef}
    />
  );
}

async function renderPrompt(value: string, allowUnicodeSkillAliases = true, registered = true) {
  await act(() => {
    if (renderer) renderer.update(composer(value, allowUnicodeSkillAliases, registered));
    else renderer = create(composer(value, allowUnicodeSkillAliases, registered));
  });
}

function $firstMention() {
  const paragraph = $getRoot().getFirstChildOrThrow();
  if (!$isElementNode(paragraph)) throw new Error("Expected a composer paragraph");
  const mention = paragraph.getFirstChildOrThrow();
  if (mention.getType() !== "composer-mention") throw new Error("Expected a mention");
  return mention;
}

function $firstSkill() {
  const paragraph = $getRoot().getFirstChildOrThrow();
  if (!$isElementNode(paragraph)) throw new Error("Expected a composer paragraph");
  const skill = paragraph.getFirstChildOrThrow();
  if (skill.getType() !== "composer-skill") throw new Error("Expected a skill");
  return skill;
}

class TestClipboardEvent extends Event {
  readonly clipboardData: DataTransfer;

  constructor(text: string) {
    super("paste", { cancelable: true });
    this.clipboardData = {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    } as unknown as DataTransfer;
  }
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { activeElement: null });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("composer mention serialization", () => {
  it.each([
    "@README.md control",
    "@terminal-1:3 Explain this output\n\n<terminal_context>\n- Terminal 1 line 3:\n  3 | output\n</terminal_context>",
    '@"docs/My \\"File\\".md" please',
    '@"docs/雪 👋.md" please',
    "[README.md](README.md) control",
    "[config#draft?.json](config%23draft%3f.json) control",
    "Plain text\n  Keep indentation 👋",
  ])("preserves the initial prompt %s", async (prompt) => {
    await renderPrompt(prompt);
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
  });

  it("preserves original source when replacing the controlled prompt", async () => {
    for (const prompt of ["", "@README.md control", "Older plain control", "@README.md control"]) {
      await renderPrompt(prompt);
      expect(editorRef.current?.readSnapshot()).toMatchObject({
        value: prompt,
        expandedCursor: prompt.length,
      });
      if (prompt === "@README.md control") {
        expect(lexicalEditor.getEditorState().read(() => $firstMention().isInline())).toBe(true);
      }
    }
  });

  it("preserves source when Lexical clones the mention and reloads exported state", async () => {
    const prompt = '@"docs/雪 👋.md" remains a chip';
    await renderPrompt(prompt);
    const originalKey = lexicalEditor.getEditorState().read(() => $firstMention().getKey());

    await act(() => {
      lexicalEditor.update(
        () => {
          const mention = $firstMention();
          mention.replace($copyNode(mention));
        },
        { discrete: true },
      );
    });
    expect(lexicalEditor.getEditorState().read(() => $firstMention().getKey())).not.toBe(
      originalKey,
    );
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
    const exportedState = lexicalEditor.getEditorState().toJSON();

    await renderPrompt("");
    await act(() => {
      lexicalEditor.setEditorState(lexicalEditor.parseEditorState(exportedState));
    });
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
    expect(lexicalEditor.getEditorState().read(() => $firstMention().isInline())).toBe(true);
  });

  it("keeps canonical serialization when importing legacy mention JSON without source", async () => {
    await renderPrompt("");
    await act(() => {
      lexicalEditor.setEditorState(
        lexicalEditor.parseEditorState(
          JSON.stringify({
            root: {
              type: "root",
              version: 1,
              children: [
                {
                  type: "paragraph",
                  version: 1,
                  children: [{ type: "composer-mention", version: 1, path: "README.md" }],
                },
              ],
            },
          }),
        ),
      );
    });
    expect(editorRef.current?.readSnapshot().value).toBe("[README.md](README.md)");
    expect(lexicalEditor.getEditorState().read(() => $firstMention().isInline())).toBe(true);
  });

  it("still serializes a newly inserted mention canonically", async () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    await renderPrompt("");
    const event = new TestClipboardEvent("@README.md ");
    await act(() => {
      lexicalEditor.update(
        () => {
          $getRoot().selectEnd();
          lexicalEditor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
        },
        { discrete: true },
      );
    });
    expect(event.defaultPrevented).toBe(true);
    expect(editorRef.current?.readSnapshot().value).toBe("[README.md](README.md) ");
    expect(lexicalEditor.getEditorState().read(() => $firstMention().isInline())).toBe(true);
  });
});

describe("composer skill serialization", () => {
  it("reinterprets astral aliases on a provider switch without changing source text", async () => {
    const prompt = "Use 𑿝review and €unknown and $review ";
    await renderPrompt(prompt, true);
    const readTypes = () =>
      lexicalEditor.getEditorState().read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        if (!$isElementNode(paragraph)) throw new Error("Expected paragraph");
        return paragraph.getChildren().map((node) => node.getType());
      });
    expect(readTypes().filter((type) => type === "composer-skill")).toHaveLength(2);
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
    expect(editorRef.current?.readSnapshot().expandedCursor).toBe(prompt.length);

    await renderPrompt(prompt, false);
    expect(readTypes().filter((type) => type === "composer-skill")).toHaveLength(1);
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
    expect(editorRef.current?.readSnapshot().expandedCursor).toBe(prompt.length);

    await renderPrompt(prompt, true);
    expect(readTypes().filter((type) => type === "composer-skill")).toHaveLength(2);
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
  });

  it("removes a Unicode chip when its catalog skill is disabled", async () => {
    const prompt = "Use €review and $review ";
    await renderPrompt(prompt, true, true);
    const countChips = () =>
      lexicalEditor.getEditorState().read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        if (!$isElementNode(paragraph)) throw new Error("Expected paragraph");
        return paragraph.getChildren().filter((node) => node.getType() === "composer-skill").length;
      });
    expect(countChips()).toBe(2);
    await renderPrompt(prompt, true, false);
    expect(countChips()).toBe(1);
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
  });

  it.each(["€review", "𑿝review"])("preserves %s across clone and JSON reload", async (prompt) => {
    await renderPrompt(`${prompt} `);
    expect(editorRef.current?.readSnapshot().value).toBe(`${prompt} `);
    await act(() => {
      lexicalEditor.update(
        () => {
          const skill = $firstSkill();
          skill.replace($copyNode(skill));
        },
        { discrete: true },
      );
    });
    const exportedState = lexicalEditor.getEditorState().toJSON();
    await renderPrompt("");
    await act(() => {
      lexicalEditor.setEditorState(lexicalEditor.parseEditorState(exportedState));
    });
    expect(editorRef.current?.readSnapshot().value).toBe(`${prompt} `);
  });

  it("reads legacy skill JSON without a source as a dollar alias", async () => {
    await renderPrompt("");
    await act(() => {
      lexicalEditor.setEditorState(
        lexicalEditor.parseEditorState(
          JSON.stringify({
            root: {
              type: "root",
              version: 1,
              children: [
                {
                  type: "paragraph",
                  version: 1,
                  children: [{ type: "composer-skill", version: 1, skillName: "review" }],
                },
              ],
            },
          }),
        ),
      );
    });
    expect(editorRef.current?.readSnapshot().value).toBe("$review");
  });
});
