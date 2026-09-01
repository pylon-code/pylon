import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveExistingThreadComposerSettings } from "./use-thread-composer-state.logic";

const selection = (instanceId: string, model: string) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const primeThread = {
  modelSelection: selection("primeAgent", "prime-model"),
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};

function provider(instanceId: string, continuationGroupKey: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    continuation: { groupKey: continuationGroupKey },
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("resolveExistingThreadComposerSettings", () => {
  it("rejects a device-local Codex draft on a Prime-bound session", () => {
    expect(
      resolveExistingThreadComposerSettings({
        thread: primeThread,
        sessionProviderInstanceId: ProviderInstanceId.make("primeAgent"),
        draft: {
          modelSelection: selection("codex", "gpt-5-codex"),
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      }),
    ).toEqual({
      modelSelection: selection("codex", "gpt-5-codex"),
      runtimeMode: "approval-required",
      interactionMode: "plan",
      rejectedDraftProviderSelection: true,
      providerBindingMismatch: true,
    });
  });

  it("keeps same-instance model and mode changes on the bound session", () => {
    expect(
      resolveExistingThreadComposerSettings({
        thread: primeThread,
        sessionProviderInstanceId: ProviderInstanceId.make("primeAgent"),
        draft: {
          modelSelection: selection("primeAgent", "prime-model-max"),
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      }),
    ).toEqual({
      modelSelection: selection("primeAgent", "prime-model-max"),
      runtimeMode: "approval-required",
      interactionMode: "plan",
      rejectedDraftProviderSelection: false,
      providerBindingMismatch: false,
    });
  });

  it("keeps the target account's intact model and options for a compatible transition", () => {
    const targetSelection = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    } as const;
    expect(
      resolveExistingThreadComposerSettings({
        thread: {
          modelSelection: selection("codex", "gpt-5.3-codex"),
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
        sessionProviderInstanceId: ProviderInstanceId.make("codex"),
        providers: [
          provider("codex", "codex:home:shared"),
          provider("codex_personal", "codex:home:shared"),
        ],
        draft: {
          modelSelection: targetSelection,
          runtimeMode: "full-access",
          interactionMode: "plan",
        },
      }),
    ).toEqual({
      modelSelection: targetSelection,
      runtimeMode: "full-access",
      interactionMode: "plan",
      rejectedDraftProviderSelection: false,
      providerBindingMismatch: false,
    });
  });

  it("blocks instead of transplanting a persisted selection across the live binding", () => {
    expect(
      resolveExistingThreadComposerSettings({
        thread: {
          ...primeThread,
          modelSelection: selection("codex", "gpt-5-codex"),
        },
        sessionProviderInstanceId: ProviderInstanceId.make("primeAgent"),
      }),
    ).toMatchObject({
      modelSelection: null,
      providerBindingMismatch: true,
    });
  });

  it("keeps the explicit draft selection for an unbound new session", () => {
    expect(
      resolveExistingThreadComposerSettings({
        thread: primeThread,
        draft: { modelSelection: selection("codex", "gpt-5-codex") },
      }),
    ).toMatchObject({
      modelSelection: selection("codex", "gpt-5-codex"),
      rejectedDraftProviderSelection: false,
    });
  });

  it("keeps the persisted thread fallback when an unbound thread has no draft selection", () => {
    expect(resolveExistingThreadComposerSettings({ thread: primeThread })).toEqual({
      ...primeThread,
      rejectedDraftProviderSelection: false,
      providerBindingMismatch: false,
    });
  });
});
