import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { detectComposerTrigger } from "@t3tools/shared/composerTrigger";
import { describe, expect, it, vi } from "vite-plus/test";

// The hook's data source pulls in the React Native query stack; the pure
// builders under test never touch it.
vi.mock("../../state/use-composer-path-search", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
}));

import type { ComposerCommandMenuProvider } from "./use-composer-command-menu";

const { buildComposerCommandItems, composerCommandReplacement, composerSelectionAtEnd } =
  await import("./use-composer-command-menu");

function skill(overrides: Partial<ServerProviderSkill> & { name: string }): ServerProviderSkill {
  return {
    path: `/skills/${overrides.name}/SKILL.md`,
    enabled: true,
    ...overrides,
  };
}

function provider(overrides: Partial<ComposerCommandMenuProvider>): ComposerCommandMenuProvider {
  return {
    instanceId: ProviderInstanceId.make("instance-1"),
    driver: ProviderDriverKind.make("claude"),
    skills: [],
    slashCommands: [],
    ...overrides,
  };
}

function trigger(text: string) {
  const detected = detectComposerTrigger(text, text.length);
  if (!detected) throw new Error(`no trigger detected for ${JSON.stringify(text)}`);
  return detected;
}

const baseInput = {
  providerSlashCommands: [],
  showInteractionModeToggle: false,
  hasThread: true,
  pathEntries: [],
} as const;

describe("detectComposerTrigger wiring", () => {
  it("recognises the three composer triggers the menu renders", () => {
    expect(trigger("/rev").kind).toBe("slash-command");
    expect(trigger("$brow").kind).toBe("skill");
    expect(trigger("look at @src/ind").kind).toBe("path");
  });

  it("returns no items without a trigger", () => {
    expect(
      buildComposerCommandItems({
        ...baseInput,
        trigger: null,
        selectedProviderStatus: provider({}),
      }),
    ).toEqual([]);
  });
});

describe("buildComposerCommandItems slash menu", () => {
  it("keeps /plan and /default out unless the interaction toggle applies", () => {
    const withoutToggle = buildComposerCommandItems({
      ...baseInput,
      trigger: trigger("/"),
      selectedProviderStatus: provider({}),
    });
    expect(withoutToggle.map((item) => item.label)).toEqual(["/model"]);

    const withToggle = buildComposerCommandItems({
      ...baseInput,
      showInteractionModeToggle: true,
      trigger: trigger("/"),
      selectedProviderStatus: provider({}),
    });
    expect(withToggle.map((item) => item.label)).toEqual(["/model", "/plan", "/default"]);
  });

  // Guards 2a099000f: disabled skills must not reach either the `/` menu or the
  // dedupe set that hides native commands.
  it("hides disabled skills and dedupes native commands against visible skills", () => {
    const items = buildComposerCommandItems({
      ...baseInput,
      trigger: trigger("/"),
      providerSlashCommands: [
        { name: "review", description: "Native review" },
        { name: "secret", description: "Native secret" },
      ],
      selectedProviderStatus: provider({
        skills: [
          skill({ name: "review", shortDescription: "Skill review" }),
          skill({ name: "secret", enabled: false, shortDescription: "Disabled skill" }),
        ],
      }),
    });

    // `review` is a visible skill, so its duplicate native command is dropped.
    expect(
      items.filter((item) => item.type === "provider-slash-command").map((i) => i.label),
    ).toEqual(["/secret"]);
    // The disabled `secret` skill never appears as a skill row.
    expect(items.filter((item) => item.type === "skill").map((i) => i.label)).toEqual([
      "skill:review",
    ]);
  });

  it("hides Codex /feedback until a thread exists", () => {
    const codex = provider({
      driver: ProviderDriverKind.make("codex"),
      slashCommands: [{ name: "feedback", description: "Send feedback" }],
    });
    const input = {
      ...baseInput,
      trigger: trigger("/f"),
      providerSlashCommands: codex.slashCommands,
      selectedProviderStatus: codex,
    };

    expect(
      buildComposerCommandItems({ ...input, hasThread: false }).map((item) => item.label),
    ).toEqual([]);
    expect(
      buildComposerCommandItems({ ...input, hasThread: true }).map((item) => item.label),
    ).toEqual(["/feedback"]);
  });
});

describe("buildComposerCommandItems skill ranking", () => {
  it("drops disabled skills and ranks name matches ahead of description matches", () => {
    const items = buildComposerCommandItems({
      ...baseInput,
      trigger: trigger("$browser"),
      selectedProviderStatus: provider({
        skills: [
          skill({ name: "deploy", shortDescription: "Ship with the browser preview" }),
          skill({ name: "browser", shortDescription: "Drive the in-app browser" }),
          skill({ name: "browser-legacy", enabled: false, shortDescription: "Old browser" }),
        ],
      }),
    });

    expect(items.map((item) => item.label)).toEqual(["browser", "deploy"]);
  });

  it("lists enabled skills unfiltered for a bare $ trigger", () => {
    const items = buildComposerCommandItems({
      ...baseInput,
      trigger: trigger("$"),
      selectedProviderStatus: provider({
        skills: [skill({ name: "alpha" }), skill({ name: "beta", enabled: false })],
      }),
    });

    expect(items.map((item) => item.label)).toEqual(["alpha"]);
  });
});

describe("buildComposerCommandItems path results", () => {
  it("splits the entry path into a label and a parent description", () => {
    const items = buildComposerCommandItems({
      ...baseInput,
      trigger: trigger("@src/ind"),
      selectedProviderStatus: provider({}),
      pathEntries: [{ path: "src/features/index.ts", kind: "file" }],
    });

    expect(items).toEqual([
      {
        id: "path:src/features/index.ts",
        type: "path",
        path: "src/features/index.ts",
        kind: "file",
        label: "index.ts",
        description: "src/features",
      },
    ]);
  });
});

describe("composerCommandReplacement", () => {
  it("writes a markdown link for a path and a skill token for a skill", () => {
    expect(
      composerCommandReplacement({
        id: "path:src/a b.ts",
        type: "path",
        path: "src/a b.ts",
        kind: "file",
        label: "a b.ts",
        description: "src",
      }),
    ).toBe("[a b.ts](src/a%20b.ts) ");
    expect(
      composerCommandReplacement({
        id: "skill:browser",
        type: "skill",
        skill: skill({ name: "browser" }),
        label: "browser",
        description: "",
      }),
    ).toBe("$browser ");
  });

  it("returns null for the interaction-mode commands so they clear the trigger", () => {
    for (const command of ["plan", "default"]) {
      expect(
        composerCommandReplacement({
          id: `cmd:${command}`,
          type: "slash-command",
          command,
          label: `/${command}`,
          description: "",
        }),
      ).toBeNull();
    }
    expect(
      composerCommandReplacement({
        id: "cmd:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "",
      }),
    ).toBe("/model ");
  });
});

describe("composerSelectionAtEnd", () => {
  it("resets a changed draft owner to the new draft end", () => {
    expect(composerSelectionAtEnd("queued task 🧪")).toEqual({ start: 14, end: 14 });
  });
});
