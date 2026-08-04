import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  isProviderInstanceDrained,
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  resolveDefaultProviderModelSelection,
  resolveSelectableProviderInstance,
  resolveProviderDriverKindForInstanceSelection,
  sortProviderInstancesForRouting,
  type ProviderInstanceEntry,
} from "./providerInstances";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
  rateLimit?: ServerProvider["rateLimit"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.rateLimit ? { rateLimit: input.rateLimit } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

const model = (slug: string, isCustom = false, isDefault = false) => ({
  slug,
  name: slug,
  isCustom,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: {},
});

describe("isProviderInstancePickerReady", () => {
  it("rejects a disabled instance even while its last probe status is ready", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        enabled: false,
      }),
    ]);

    expect(entry?.status).toBe("ready");
    expect(entry && isProviderInstancePickerReady(entry)).toBe(false);
  });

  it("accepts an enabled, available, ready instance", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
    ]);

    expect(entry && isProviderInstancePickerReady(entry)).toBe(true);
  });
});

describe("isProviderInstancePickerVisible", () => {
  it("keeps enabled instances in the rail and removes disabled instances", () => {
    const [enabledEntry, disabledEntry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        enabled: false,
      }),
    ]);

    expect(enabledEntry && isProviderInstancePickerVisible(enabledEntry)).toBe(true);
    expect(disabledEntry && isProviderInstancePickerVisible(disabledEntry)).toBe(false);
  });
});

describe("applyProviderInstanceSettings", () => {
  it("uses settings when a streamed snapshot still reports a disabled default as enabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
        },
      },
      providers: {} as never,
    });

    expect(entry?.enabled).toBe(false);
  });

  it("treats a removed custom instance snapshot as disabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_work",
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {},
      providers: {} as never,
    });

    expect(entry?.enabled).toBe(false);
  });

  it("carries the configured drain priority onto the entry", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claude_work" }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {
        [ProviderInstanceId.make("claude_work")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          priority: 1,
        },
      },
      providers: {} as never,
    });

    expect(entry?.priority).toBe(1);
  });
});

describe("account drain routing", () => {
  const NOW_MS = Date.parse("2026-08-04T18:00:00.000Z");
  const claude = ProviderDriverKind.make("claudeAgent");

  const drainedProvider = (instanceId: string, resetsAt: string | undefined) =>
    provider({
      provider: claude,
      instanceId,
      rateLimit: {
        status: "rejected",
        rateLimitType: "five_hour",
        observedAt: "2026-08-04T17:00:00.000Z",
        ...(resetsAt ? { resetsAt } : {}),
      },
    });

  const entryFor = (snapshot: ServerProvider) => {
    const [entry] = deriveProviderInstanceEntries([snapshot]);
    if (!entry) throw new Error("expected an entry");
    return entry;
  };

  describe("isProviderInstanceDrained", () => {
    it("drains an instance whose window has not reset yet", () => {
      const entry = entryFor(drainedProvider("claude_primary", "2026-08-04T21:00:00.000Z"));

      expect(isProviderInstanceDrained(entry, NOW_MS)).toBe(true);
    });

    it("recovers once the reset time passes", () => {
      const entry = entryFor(drainedProvider("claude_primary", "2026-08-04T17:30:00.000Z"));

      expect(isProviderInstanceDrained(entry, NOW_MS)).toBe(false);
    });

    // A rejection with nothing to expire would route away from the account
    // forever, so it is deliberately not honored.
    it.each([
      ["a verdict with no reset time", drainedProvider("claude_primary", undefined)],
      ["an unparseable reset time", drainedProvider("claude_primary", "not-a-date")],
      ["no rate-limit state at all", provider({ provider: claude, instanceId: "claude_primary" })],
      [
        "an allowed verdict",
        provider({
          provider: claude,
          instanceId: "claude_primary",
          rateLimit: {
            status: "allowed",
            observedAt: "2026-08-04T17:00:00.000Z",
            resetsAt: "2026-08-04T21:00:00.000Z",
          },
        }),
      ],
    ])("does not drain on %s", (_label, snapshot) => {
      expect(isProviderInstanceDrained(entryFor(snapshot), NOW_MS)).toBe(false);
    });
  });

  describe("sortProviderInstancesForRouting", () => {
    const withPriority = (entry: ProviderInstanceEntry, priority: number) => ({
      ...entry,
      priority,
    });

    it("prefers the highest-priority healthy instance", () => {
      const entries = [
        withPriority(entryFor(provider({ provider: claude, instanceId: "claude_third" })), 2),
        withPriority(entryFor(provider({ provider: claude, instanceId: "claude_first" })), 0),
      ];

      expect(sortProviderInstancesForRouting(entries, NOW_MS).map((e) => e.instanceId)).toEqual([
        "claude_first",
        "claude_third",
      ]);
    });

    it("skips a drained instance even when it sorts first by priority", () => {
      const entries = [
        withPriority(entryFor(drainedProvider("claude_primary", "2026-08-04T21:00:00.000Z")), 0),
        withPriority(entryFor(provider({ provider: claude, instanceId: "claude_backup" })), 1),
      ];

      expect(sortProviderInstancesForRouting(entries, NOW_MS).map((e) => e.instanceId)).toEqual([
        "claude_backup",
        "claude_primary",
      ]);
    });

    // Better to attempt the turn and surface the provider's own error than to
    // resolve nothing and leave the composer unable to send.
    it("still resolves an instance when every one is drained", () => {
      const entries = [
        withPriority(entryFor(drainedProvider("claude_backup", "2026-08-04T22:00:00.000Z")), 1),
        withPriority(entryFor(drainedProvider("claude_primary", "2026-08-04T21:00:00.000Z")), 0),
      ];

      expect(sortProviderInstancesForRouting(entries, NOW_MS).map((e) => e.instanceId)).toEqual([
        "claude_primary",
        "claude_backup",
      ]);
    });

    it("keeps the existing order for instances with no priority configured", () => {
      const entries = [
        entryFor(provider({ provider: claude, instanceId: "claude_a" })),
        entryFor(provider({ provider: claude, instanceId: "claude_b" })),
      ];

      expect(sortProviderInstancesForRouting(entries, NOW_MS).map((e) => e.instanceId)).toEqual([
        "claude_a",
        "claude_b",
      ]);
    });

    it("orders an explicitly prioritized instance ahead of unprioritized ones", () => {
      const entries = [
        entryFor(provider({ provider: claude, instanceId: "claude_unset" })),
        withPriority(entryFor(provider({ provider: claude, instanceId: "claude_first" })), 5),
      ];

      expect(sortProviderInstancesForRouting(entries, NOW_MS).map((e) => e.instanceId)).toEqual([
        "claude_first",
        "claude_unset",
      ]);
    });
  });

  // Every caller that resolves without an explicit request routes through the
  // shared helper, so project creation and new threads cannot diverge.
  describe("resolveSelectableProviderInstance", () => {
    it("skips a drained account when nothing was requested", () => {
      const instanceId = resolveSelectableProviderInstance(
        [
          drainedProvider("claude_primary", "2026-08-04T21:00:00.000Z"),
          provider({ provider: claude, instanceId: "claude_backup" }),
        ],
        undefined,
        NOW_MS,
      );

      expect(instanceId).toBe("claude_backup");
    });

    it("honors an explicitly requested account even while it is drained", () => {
      const instanceId = resolveSelectableProviderInstance(
        [
          drainedProvider("claude_primary", "2026-08-04T21:00:00.000Z"),
          provider({ provider: claude, instanceId: "claude_backup" }),
        ],
        ProviderInstanceId.make("claude_primary"),
        NOW_MS,
      );

      expect(instanceId).toBe("claude_primary");
    });

    it("falls back to a drained account when every account is spent", () => {
      const instanceId = resolveSelectableProviderInstance(
        [
          drainedProvider("claude_primary", "2026-08-04T21:00:00.000Z"),
          drainedProvider("claude_backup", "2026-08-04T22:00:00.000Z"),
        ],
        undefined,
        NOW_MS,
      );

      expect(instanceId).toBe("claude_primary");
    });
  });

  // Project creation persists this, so it must not write a spent account.
  describe("resolveDefaultProviderModelSelection", () => {
    it("seeds a new project with an account that can serve a turn", () => {
      const selection = resolveDefaultProviderModelSelection(
        [
          drainedProvider("claude_primary", "2026-08-04T21:00:00.000Z"),
          provider({
            provider: claude,
            instanceId: "claude_backup",
            models: [model("sonnet", false, true)],
          }),
        ],
        null,
        NOW_MS,
      );

      expect(selection?.instanceId).toBe("claude_backup");
      expect(selection?.model).toBe("sonnet");
    });
  });
});

describe("deriveProviderInstanceEntries", () => {
  it("uses explicit instance id and driver kind from the snapshot", () => {
    const snapshot = provider({
      provider: ProviderDriverKind.make("codex"),
      instanceId: "codex_personal",
    });
    const [entry] = deriveProviderInstanceEntries([snapshot]);

    expect(entry?.instanceId).toBe("codex_personal");
    expect(entry?.driverKind).toBe("codex");
    expect(entry?.isDefault).toBe(false);
  });
});

describe("resolveSelectableProviderInstance", () => {
  it("returns the requested instance when it is enabled and available", () => {
    const requested = ProviderInstanceId.make("claude_work");
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: requested }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("falls back to the first enabled and available instance", () => {
    const disabled = ProviderInstanceId.make("codex");
    const fallback = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: fallback }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBe(fallback);
  });

  it("prefers a ready instance over an enabled one whose driver cannot start", () => {
    const notInstalled = ProviderInstanceId.make("codex");
    const ready = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: notInstalled,
        status: "error",
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: ready }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBe(ready);
  });

  it("prefers an unprobed (warning) instance over one whose probe errored", () => {
    const notInstalled = ProviderInstanceId.make("codex");
    const unprobed = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: notInstalled,
        status: "error",
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: unprobed,
        status: "warning",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBe(unprobed);
  });

  it("keeps a requested instance even when its probe errored", () => {
    const requested = ProviderInstanceId.make("codex");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: requested,
        status: "error",
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("does not invent an errored instance as a new-user default", () => {
    const notInstalled = ProviderInstanceId.make("codex");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: notInstalled,
        status: "error",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBeUndefined();
  });

  it("does not return disabled, unavailable, or unknown instances when none are sendable", () => {
    const disabled = ProviderInstanceId.make("codex");
    const unavailable = ProviderInstanceId.make("claudeAgent");
    const unknown = ProviderInstanceId.make("removed_instance");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: unavailable,
        availability: "unavailable",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unavailable)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unknown)).toBeUndefined();
  });
});

describe("resolveProviderDriverKindForInstanceSelection", () => {
  it("maps custom provider instance ids back to their driver kind", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        displayName: "Claude OpenRouter",
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("claude_openrouter"),
      ),
    ).toBe("claudeAgent");
  });

  it("does not guess a provider kind when the instance selection is unknown", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex", enabled: false }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("removed_instance"),
      ),
    ).toBeUndefined();
  });
});

describe("getDefaultProviderInstanceModel", () => {
  it("uses the instance's own models, not the default instance of the kind", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        models: [model("openai/gpt-5.5", true), model("claude-opus-4-8")],
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-sonnet-5")],
      }),
    ];

    expect(
      getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("claude_openrouter")),
    ).toBe("claude-opus-4-8");
  });

  it("falls back to the driver default when the instance reports no models", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];

    const resolved = getDefaultProviderInstanceModel(
      providers,
      ProviderInstanceId.make("claudeAgent"),
    );
    expect(typeof resolved).toBe("string");
    expect(resolved?.length).toBeGreaterThan(0);
  });

  it("honors the instance's declared default before model-list order", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-sonnet-5"), model("claude-opus-4-8", false, true)],
      }),
    ];

    expect(getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("claudeAgent"))).toBe(
      "claude-opus-4-8",
    );
  });

  it("returns undefined for an unknown instance", () => {
    expect(
      getDefaultProviderInstanceModel([], ProviderInstanceId.make("removed_instance")),
    ).toBeUndefined();
  });
});

describe("resolveDefaultProviderModelSelection", () => {
  it.each([
    ["codex", "codex", "gpt-5.6"],
    ["claudeAgent", "claudeAgent", "claude-fable-5"],
    ["cursor", "cursor", "composer-2"],
  ])("uses the only available %s instance", (driver, instanceId, modelSlug) => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make(driver),
        instanceId,
        models: [model(modelSlug, false, true)],
      }),
    ];

    expect(resolveDefaultProviderModelSelection(providers, null)).toEqual({
      instanceId,
      model: modelSlug,
    });
  });

  it("preserves a valid stored selection including its options", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-opus-4-8")],
      }),
    ];
    const stored = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "custom-model",
      options: [{ id: "effort", value: "high" }],
    };

    expect(resolveDefaultProviderModelSelection(providers, stored)).toBe(stored);
  });

  it("replaces a stale stored instance with the first ready instance and its model", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        status: "warning",
        models: [model("gpt-5.6")],
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-opus-4-8", false, true)],
      }),
    ];

    expect(
      resolveDefaultProviderModelSelection(providers, {
        instanceId: ProviderInstanceId.make("removed-provider"),
        model: "stale-model",
      }),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-4-8" });
  });

  it.each([{ enabled: false }, { availability: "unavailable" as const }])(
    "replaces an unavailable stored instance deterministically",
    (requestedState) => {
      const providers = [
        provider({
          provider: ProviderDriverKind.make("codex"),
          instanceId: "codex",
          models: [model("gpt-5.6")],
          ...requestedState,
        }),
        provider({
          provider: ProviderDriverKind.make("claudeAgent"),
          instanceId: "claudeAgent",
          models: [model("claude-opus-4-8", false, true)],
        }),
      ];

      expect(
        resolveDefaultProviderModelSelection(providers, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6",
        }),
      ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-4-8" });
    },
  );

  it("returns no selection for empty, disabled, unavailable, or error-only profiles", () => {
    expect(resolveDefaultProviderModelSelection([], null)).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("codex"),
            instanceId: "codex",
            enabled: false,
          }),
        ],
        null,
      ),
    ).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("codex"),
            instanceId: "codex",
            availability: "unavailable",
          }),
        ],
        null,
      ),
    ).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("codex"),
            instanceId: "codex",
            status: "error",
          }),
        ],
        null,
      ),
    ).toBeNull();
  });
});
