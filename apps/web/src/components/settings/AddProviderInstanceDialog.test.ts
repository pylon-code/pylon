import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveWizardNavigation } from "./AddProviderInstanceDialog.logic";
import {
  PROVIDER_CLIENT_DEFINITIONS,
  PROVIDER_CLIENT_DEFINITION_BY_VALUE,
} from "./providerDriverMeta";

describe("resolveWizardNavigation", () => {
  const invalidId = { instanceIdError: "Instance ID is required." };
  const validId = { instanceIdError: null };

  it("allows moving from Driver to Identity before the instance id is valid", () => {
    expect(resolveWizardNavigation(0, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
  });

  it("blocks Next from Identity to Config while the instance id is invalid", () => {
    expect(resolveWizardNavigation(1, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("stops a direct Driver-to-Config skip at Identity and surfaces its error", () => {
    expect(resolveWizardNavigation(0, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("allows advancing and skipping forward once the instance id is valid", () => {
    expect(resolveWizardNavigation(1, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
  });

  it("always preserves backward Driver and Identity navigation", () => {
    expect(resolveWizardNavigation(2, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
    expect(resolveWizardNavigation(2, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
    expect(resolveWizardNavigation(1, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });

  it("clamps requested steps to the wizard bounds", () => {
    expect(resolveWizardNavigation(2, 8, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, -1, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });
});

describe("Add Provider driver choices", () => {
  const jcode = ProviderDriverKind.make("jcode");

  // The dialog's Driver step maps over `PROVIDER_CLIENT_DEFINITIONS` and its
  // Config step looks the chosen driver up in `PROVIDER_CLIENT_DEFINITION_BY_VALUE`,
  // so both assertions together prove Jcode is selectable and configurable
  // rather than silently falling back to the first driver's schema.
  it("offers Jcode as a selectable driver", () => {
    expect(PROVIDER_CLIENT_DEFINITIONS.map((definition) => definition.value)).toContain(jcode);
  });

  it("resolves the Jcode config step from its own client definition", () => {
    expect(PROVIDER_CLIENT_DEFINITION_BY_VALUE[jcode]).toMatchObject({
      value: jcode,
      label: "Jcode",
      badgeLabel: "Early Access",
    });
    expect(PROVIDER_CLIENT_DEFINITION_BY_VALUE[jcode]).not.toBe(PROVIDER_CLIENT_DEFINITIONS[0]);
  });
});
