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
  readonly accountId?: string;
  readonly backends?: ServerProvider["backends"];
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
    auth: {
      status: "authenticated",
      ...(input.accountId ? { accountId: input.accountId } : {}),
    },
    checkedAt: "2026-08-06T11:59:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
    ...(input.usedPercent === undefined ? {} : { usageLimits: limits(input.usedPercent) }),
    ...(input.backends ? { backends: input.backends } : {}),
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
const CODEX = provider({
  instanceId: "codex",
  driver: "codex",
  usedPercent: 70,
  accountId: "acct_codex",
});
const PRIME_MODELS: ServerProvider["models"] = [
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
];
// Nothing readable about Prime's sign-ins: the configured accounts stand in.
const PRIME = provider({ instanceId: "primeAgent", driver: "primeAgent", models: PRIME_MODELS });
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
    // Prime's own reading, taken with its own sign-in, is the truth: no
    // matching needed and no configured account implicated.
    it("shows Prime's own reading for an Anthropic model when it has one", () => {
      const prime = provider({
        instanceId: "primeAgent",
        driver: "primeAgent",
        displayName: "Prime Agent",
        models: PRIME_MODELS,
        backends: [{ backend: "anthropic", usageLimits: limits(33) }],
      });
      const usage = deriveComposerUsage({
        providerStatuses: [CLAUDE, CLAUDE_PERSONAL, CODEX, prime],
        selectedInstanceId: "primeAgent",
        selectedModel: "anthropic/claude-opus-5",
        enabled: true,
      });

      expect(usage.accounts.map((account) => account.instanceId)).toEqual(["primeAgent"]);
      expect(usage.primary?.usageLimits.windows[0]?.usedPercent).toBe(33);
      expect(usage.backend).toEqual({
        driver: "claudeAgent",
        label: "Claude",
        model: "Claude Opus 5",
        verification: "own",
      });
    });

    it("falls back to the Claude accounts, labelled as assumed, without a reading", () => {
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
      // No account is "this thread's"; the default instance leads.
      expect(usage.accounts.every((account) => !account.isActive)).toBe(true);
      expect(usage.primary?.instanceId).toBe("claudeAgent");
      expect(usage.backend?.verification).toBe("assumed");
    });

    it("shows the Codex account whose identity Prime's sign-in matches", () => {
      const prime = provider({
        instanceId: "primeAgent",
        driver: "primeAgent",
        models: PRIME_MODELS,
        backends: [{ backend: "openai-codex", accountId: "acct_codex" }],
      });
      const other = provider({
        instanceId: "codex_work",
        driver: "codex",
        usedPercent: 10,
        accountId: "acct_other",
      });
      const usage = deriveComposerUsage({
        providerStatuses: [CLAUDE, CODEX, other, prime],
        selectedInstanceId: "primeAgent",
        selectedModel: "openai-codex/gpt-5.6",
        enabled: true,
      });

      expect(usage.accounts.map((account) => account.instanceId)).toEqual(["codex"]);
      expect(usage.primary?.instanceId).toBe("codex");
      expect(usage.primary?.isActive).toBe(true);
      expect(usage.backend?.verification).toBe("matched");
    });

    // A number that is provably some other account's is worse than none.
    it("shows nothing when Prime is signed in to a Codex account not configured here", () => {
      const prime = provider({
        instanceId: "primeAgent",
        driver: "primeAgent",
        models: PRIME_MODELS,
        backends: [{ backend: "openai-codex", accountId: "acct_elsewhere" }],
      });
      const usage = deriveComposerUsage({
        providerStatuses: [CODEX, prime],
        selectedInstanceId: "primeAgent",
        selectedModel: "openai-codex/gpt-5.6",
        enabled: true,
      });

      expect(usage.accounts).toEqual([]);
      expect(usage.primary).toBeNull();
      expect(usage.backend?.verification).toBe("mismatch");
    });

    it("assumes the Codex account when neither side reports an identity", () => {
      const codexWithoutId = provider({ instanceId: "codex", driver: "codex", usedPercent: 70 });
      const usage = deriveComposerUsage({
        providerStatuses: [codexWithoutId, PRIME],
        selectedInstanceId: "primeAgent",
        selectedModel: "openai-codex/gpt-5.6",
        enabled: true,
      });

      expect(usage.primary?.instanceId).toBe("codex");
      expect(usage.backend?.verification).toBe("assumed");
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
