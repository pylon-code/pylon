import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ComposerCommandMenu, composerSuggestionOptionId } from "./ComposerCommandMenu";

describe("composerSuggestionOptionId", () => {
  it("keeps whitespace, escape-like paths, and malformed UTF-16 distinct", () => {
    const paths = [
      "docs/my file.md",
      "docs/my_file.md",
      "docs/my%20file.md",
      "docs/my\tfile.md",
      "docs/\ud800.md",
      "docs/\ud801.md",
      "docs/\udc00.md",
      "docs/\ufffd.md",
      "docs/\\ud800.md",
      "docs/\ud83d\ude80.md",
    ];
    const ids = paths.map((path) => composerSuggestionOptionId("suggestions", `path:file:${path}`));

    expect(new Set(ids).size).toBe(paths.length);
    for (const id of ids) expect(id).not.toMatch(/\s|[\ud800-\udfff]/u);
    expect(composerSuggestionOptionId("other-composer", paths[0]!)).not.toBe(
      composerSuggestionOptionId("suggestions", paths[0]!),
    );
  });
});

describe("ComposerCommandMenu", () => {
  it("renders slash-command results as an attached composer drawer", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="test-suggestions"
        items={[]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId={null}
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('data-composer-command-drawer="true"');
    expect(markup).not.toContain("dropdown-glass");
  });

  it("renders commands without a category heading or invented icons", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="test-suggestions"
        items={[
          {
            id: "slash:model",
            type: "slash-command",
            command: "model",
            label: "/model",
            description: "Switch response model for this thread",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="slash:model"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("/model");
    expect(markup).toContain("Switch response model for this thread");
    expect(markup).not.toContain("Built-in");
    expect(markup).not.toContain("<svg");
    expect(markup).toContain("font-sans text-xs font-medium");
    expect(markup).not.toContain("font-mono");
    expect(markup).not.toContain("grid-cols-");
    expect(markup).toContain("max-w-[45%]");
    expect(markup).toContain("text-left");
  });

  it("names the listbox and exposes the active option to the editor", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="test-suggestions"
        items={[
          {
            id: "slash:model",
            type: "slash-command",
            command: "model",
            label: "/model",
            description: "Switch response model for this thread",
          },
          {
            id: "slash:plan",
            type: "slash-command",
            command: "plan",
            label: "/plan",
            description: "Switch this thread into plan mode",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="slash:plan"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );
    const openingTag = (id: string) =>
      markup.match(
        new RegExp(`<[^>]*\\sid="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`),
      )?.[0] ?? "";

    const listbox = openingTag("test-suggestions");
    expect(listbox).toContain('role="listbox"');
    expect(listbox).toContain('aria-label="Commands"');
    const active = openingTag(composerSuggestionOptionId("test-suggestions", "slash:plan"));
    expect(active).toContain('role="option"');
    expect(active).toContain('aria-selected="true"');
    const inactive = openingTag(composerSuggestionOptionId("test-suggestions", "slash:model"));
    expect(inactive).toContain('role="option"');
    expect(inactive).toContain('aria-selected="false"');
  });

  it("renders the skill source icon inside its badge", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="test-suggestions"
        items={[
          {
            id: "skill:codex:browser",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "browser",
              path: "/Users/maria/.codex/plugins/browser/skills/browser/SKILL.md",
              scope: "user",
              enabled: true,
            },
            label: "Browser",
            description: "Open and control the in-app browser",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="skill"
        activeItemId="skill:codex:browser"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("Browser");
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain(">App Skill</span>");
    expect(markup).toContain("Open and control the in-app browser");
    expect(markup).not.toContain("max-w-[48ch]");
    expect(markup).toContain("text-secondary-label text-xs");
    expect(markup).toContain("ms-auto");
    expect(markup).toContain("text-current");
    expect(markup.indexOf("Open and control the in-app browser")).toBeLessThan(
      markup.indexOf(">App Skill</span>"),
    );
    expect(markup).toContain("<svg");
    expect(markup.indexOf('data-slot="badge"')).toBeLessThan(markup.indexOf("<svg"));
  });

  it("keeps slash skills aligned with the source icon inside the badge", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="test-suggestions"
        items={[
          {
            id: "skill:codex:ask-matt",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "ask-matt",
              displayName: "Ask Matt",
              path: "/skills/ask-matt/SKILL.md",
              scope: "repo",
              enabled: true,
            },
            label: "/skill:ask-matt",
            description: "Find the right skill or workflow",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="skill:codex:ask-matt"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('<span class="text-secondary-label">/skill:</span>Ask Matt');
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain("lucide-folder");
    expect(markup).toContain(">Repo</span>");
    expect(markup).toContain("Find the right skill or workflow");
    expect(markup).not.toContain("font-medium text-secondary-label");
  });
});
