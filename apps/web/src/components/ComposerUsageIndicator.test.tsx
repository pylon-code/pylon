import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { deriveComposerUsage, hasComposerUsageContent } from "../providerUsageAccounts";
import { shouldShowComposerContextStrip } from "./BranchToolbar.logic";
import { ComposerUsageIndicator } from "./ComposerUsageIndicator";

const prime: ServerProvider = {
  instanceId: ProviderInstanceId.make("primeAgent"),
  driver: ProviderDriverKind.make("primeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-10T12:00:00.000Z",
  models: [
    { slug: "default", name: "Prime Agent Default", isCustom: false, capabilities: null },
    {
      slug: "prime-inference/claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      subProvider: "prime-inference",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "openai/gpt-5.6",
      name: "GPT-5.6",
      subProvider: "openai",
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
  ],
  slashCommands: [],
  skills: [],
};
const codex: ServerProvider = {
  ...prime,
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex Work",
  models: [],
  auth: { status: "authenticated", accountId: "codex-account" },
  usageLimits: {
    source: "codex",
    checkedAt: "2026-09-10T12:00:00.000Z",
    windows: [{ label: "Session", usedPercent: 37, windowDurationMins: 300 }],
  },
};

function renderUsage(
  selectedModel: string | null,
  options: { enabled?: boolean; backends?: ServerProvider["backends"] } = {},
) {
  const usage = deriveComposerUsage({
    providerStatuses: [
      codex,
      { ...prime, ...(options.backends ? { backends: options.backends } : {}) },
    ],
    selectedInstanceId: prime.instanceId,
    selectedModel,
    enabled: options.enabled ?? true,
  });
  // Exercise the gate ChatView uses when there are no other reasons to show the strip.
  const showStrip = shouldShowComposerContextStrip({
    hasActiveProject: true,
    isGitRepo: false,
    showEnvironmentIndicator: false,
    hostsRestingComposerControls: false,
    hasCapacityReading: hasComposerUsageContent(usage),
  });
  const html = renderToStaticMarkup(
    <ComposerUsageIndicator
      environmentId={EnvironmentId.make("test-environment")}
      usage={usage}
      timestampFormat="24-hour"
      staleAfterMs={300_000}
    />,
  );
  return { html, showStrip, usage };
}

describe("ComposerUsageIndicator", () => {
  it.each(["prime-inference/claude-haiku-4-5", "openai/gpt-5.6"])(
    "keeps the strip visible and explains unreported capacity for %s",
    (selectedModel) => {
      const { html, showStrip } = renderUsage(selectedModel);

      expect(showStrip).toBe(true);
      expect(html).toContain(">Capacity not reported for this backend</span>");
      expect(html).not.toContain("Codex Work");
      expect(html).not.toContain("37%");
      expect(html).not.toContain("<button");
    },
  );

  it.each(["default", "prime-inference/unknown", null])(
    "renders nothing and leaves the empty strip hidden for %s",
    (selectedModel) => {
      const { html, showStrip } = renderUsage(selectedModel);
      expect(html).toBe("");
      expect(showStrip).toBe(false);
    },
  );

  it("hides unreported capacity when provider usage is disabled", () => {
    const { html, showStrip } = renderUsage("prime-inference/claude-haiku-4-5", { enabled: false });
    expect(html).toBe("");
    expect(showStrip).toBe(false);
  });

  it.each([
    { verification: "assumed", backends: [] },
    {
      verification: "matched",
      backends: [{ backend: "openai-codex", accountId: "codex-account" }],
    },
    {
      verification: "own",
      backends: [{ backend: "openai-codex", usageLimits: codex.usageLimits }],
    },
  ])("preserves $verification capacity for a mapped backend", ({ verification, backends }) => {
    const { html, showStrip, usage } = renderUsage("openai-codex/gpt-5.6", { backends });
    expect(showStrip).toBe(true);
    expect(usage.backend?.verification).toBe(verification);
    expect(html).toContain(">37%</span>");
    expect(html).toContain('aria-label="Subscription capacity for ');
    expect(html).not.toContain("Capacity not reported for this backend");
  });

  it("preserves the distinct account mismatch message without borrowing capacity", () => {
    const { html, showStrip, usage } = renderUsage("openai-codex/gpt-5.6", {
      backends: [{ backend: "openai-codex", accountId: "different-account" }],
    });
    expect(showStrip).toBe(true);
    expect(usage.backend?.verification).toBe("mismatch");
    expect(html).toContain(">Capacity unavailable</span>");
    expect(html).toContain('aria-label="Subscription capacity unavailable"');
    expect(html).not.toContain("37%");
    expect(html).not.toContain("Capacity not reported for this backend");
  });
});
