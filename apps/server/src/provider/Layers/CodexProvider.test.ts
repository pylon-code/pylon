import { assert, it } from "@effect/vitest";

import * as CodexSchema from "effect-codex-app-server/schema";

import {
  applyPreferredCodexDefaultModel,
  codexAccountAuthLabel,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("labels every account plan Codex can report", () => {
  // `planType` is an open string, so exhaustiveness no longer pins these
  // mappings — this table is what does. Reordering a plan into the wrong group,
  // or dropping a fall-through, changes user-visible text in Settings and fails
  // here.
  const labels: ReadonlyArray<readonly [string, string]> = [
    ["free", "ChatGPT Free Subscription"],
    ["go", "ChatGPT Go Subscription"],
    ["plus", "ChatGPT Plus Subscription"],
    ["pro", "ChatGPT Pro 20x Subscription"],
    ["prolite", "ChatGPT Pro 5x Subscription"],
    ["team", "ChatGPT Team Subscription"],
    ["self_serve_business_prolite", "ChatGPT Business Subscription"],
    ["self_serve_business_usage_based", "ChatGPT Business Subscription"],
    ["business", "ChatGPT Business Subscription"],
    ["ent26", "ChatGPT Enterprise Subscription"],
    ["enterprise_cbp_automation", "ChatGPT Enterprise Subscription"],
    ["enterprise_cbp_usage_based", "ChatGPT Enterprise Subscription"],
    ["enterprise", "ChatGPT Enterprise Subscription"],
    ["edu", "ChatGPT Edu Subscription"],
    ["edu_plus", "ChatGPT Edu Subscription"],
    ["edu_pro", "ChatGPT Edu Subscription"],
    ["unknown", "ChatGPT Subscription"],
  ];

  for (const [planType, expected] of labels) {
    assert.strictEqual(
      codexAccountAuthLabel({
        email: "user@example.com",
        planType: planType as CodexSchema.V2GetAccountResponse__PlanType,
        type: "chatgpt",
      }),
      expected,
    );
  }
});

it("falls back to a generic label for a plan Codex has not published yet", () => {
  // The point of opening `planType`: an unknown plan costs the label, not the
  // provider. Everything else on the account still decodes.
  assert.strictEqual(
    codexAccountAuthLabel({
      email: "user@example.com",
      planType: "plan_from_the_future" as CodexSchema.V2GetAccountResponse__PlanType,
      type: "chatgpt",
    }),
    "ChatGPT Subscription",
  );
});

it("labels non-ChatGPT account types", () => {
  assert.strictEqual(codexAccountAuthLabel({ type: "apiKey" }), "OpenAI API Key");
  assert.strictEqual(codexAccountAuthLabel({ type: "amazonBedrock" }), "Amazon Bedrock");
  assert.strictEqual(codexAccountAuthLabel(undefined), undefined);
  assert.strictEqual(codexAccountAuthLabel(null), undefined);
});
