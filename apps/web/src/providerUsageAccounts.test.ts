import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveComposerUsage, EMPTY_COMPOSER_USAGE } from "./providerUsageAccounts";

const limits = (usedPercent: number): ServerProviderUsageLimits => ({
  source: "test",
  checkedAt: "2026-08-06T11:59:00.000Z",
  windows: [{ label: "Session", usedPercent, windowDurationMins: 300 }],
});

function provider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName?: string;
  readonly usedPercent?: number;
  readonly models?: ServerProvider["models"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-06T11:59:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
    ...(input.usedPercent === undefined ? {} : { usageLimits: limits(input.usedPercent) }),
  };
}

const CLAUDE = provider({
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  displayName: "Claude Work",
  usedPercent: 40,
});
const CLAUDE_PERSONAL = provider({
  instanceId: "claude_personal",
  driver: "claudeAgent",
  displayName: "Claude Personal",
  usedPercent: 5,
});
const CODEX = provider({ instanceId: "codex", driver: "codex", usedPercent: 70 });
const PRIME = provider({
  instanceId: "primeAgent",
  driver: "primeAgent",
  models: [
    { slug: "default", name: "Prime Agent Default", isCustom: false, capabilities: null },
    {
      slug: "anthropic/claude-opus-5",
      name: "Claude Opus 5",
      subProvider: "anthropic",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "openai-codex/gpt-5.6",
      name: "GPT-5.6",
      subProvider: "openai-codex",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "prime-inference/qwen",
      name: "Qwen",
      subProvider: "prime-inference",
      isCustom: false,
      capabilities: null,
    },
  ],
});
const ALL = [CLAUDE, CLAUDE_PERSONAL, CODEX, PRIME];

describe("deriveComposerUsage", () => {
  it("shows every account of the selected driver, the selected one leading", () => {
    const usage = deriveComposerUsage({
      providerStatuses: ALL,
      selectedInstanceId: "claude_personal",
      selectedModel: "claude-sonnet-5",
      enabled: true,
    });

    expect(usage.accounts.map((account) => `${account.displayName}:${account.isActive}`)).toEqual([
      "Claude Work:false",
      "Claude Personal:true",
    ]);
    expect(usage.primary?.instanceId).toBe("claude_personal");
    expect(usage.backend).toBeNull();
  });

  // An account with no reading yet cannot lead the strip, but its siblings
  // still belong in the comparison.
  it("has nothing to lead with when the selected account reports no capacity", () => {
    const silent = provider({ instanceId: "claude_personal", driver: "claudeAgent" });
    const usage = deriveComposerUsage({
      providerStatuses: [CLAUDE, silent],
      selectedInstanceId: "claude_personal",
      selectedModel: null,
      enabled: true,
    });

    expect(usage.primary).toBeNull();
    expect(usage.accounts.map((account) => account.instanceId)).toEqual(["claudeAgent"]);
  });

  describe("on Prime Agent", () => {
    it("shows the Claude accounts for an Anthropic model", () => {
      const usage = deriveComposerUsage({
        providerStatuses: ALL,
        selectedInstanceId: "primeAgent",
        selectedModel: "anthropic/claude-opus-5",
        enabled: true,
      });

      expect(usage.accounts.map((account) => account.instanceId)).toEqual([
        "claudeAgent",
        "claude_personal",
      ]);
      // Prime signs in on its own, so no account is "this thread's"; the
      // default instance leads.
      expect(usage.accounts.every((account) => !account.isActive)).toBe(true);
      expect(usage.primary?.instanceId).toBe("claudeAgent");
      expect(usage.backend).toEqual({
        driver: "claudeAgent",
        label: "Claude",
        model: "Claude Opus 5",
      });
    });

    it("shows the Codex account for an OpenAI Codex model", () => {
      const usage = deriveComposerUsage({
        providerStatuses: ALL,
        selectedInstanceId: "primeAgent",
        selectedModel: "openai-codex/gpt-5.6",
        enabled: true,
      });

      expect(usage.primary?.instanceId).toBe("codex");
      expect(usage.backend?.label).toBe("Codex");
    });

    it.each([
      ["Prime's own default", "default"],
      ["a backend Pylon has no driver for", "prime-inference/qwen"],
      ["an unknown slug", "anthropic/not-listed"],
      ["no model", null],
    ])("shows nothing for %s", (_label, selectedModel) => {
      expect(
        deriveComposerUsage({
          providerStatuses: ALL,
          selectedInstanceId: "primeAgent",
          selectedModel,
          enabled: true,
        }),
      ).toBe(EMPTY_COMPOSER_USAGE);
    });
  });

  it.each([
    ["disabled in settings", { selectedInstanceId: "codex", enabled: false }],
    ["no selection", { selectedInstanceId: null, enabled: true }],
    ["an unknown instance", { selectedInstanceId: "codex_gone", enabled: true }],
  ])("shows nothing when %s", (_label, input) => {
    expect(deriveComposerUsage({ providerStatuses: ALL, selectedModel: null, ...input })).toBe(
      EMPTY_COMPOSER_USAGE,
    );
  });
});
