import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getThreadComposerModelChangeDisabledReason,
  resolveThreadComposerAdmissionReason,
  resolveThreadComposerAuthority,
  threadComposerShowsStopAction,
} from "./ThreadComposer.logic";

import {
  formatModelChangeDisabledReason,
  PRIME_AGENT_DEFAULT_MODEL_CHANGE_DESCRIPTION,
  STARTED_THREAD_MODEL_CHANGE_DESCRIPTION,
} from "@t3tools/shared/model";
import type { ModelOption } from "../../lib/modelOptions";

const PRIME_REASON =
  "Prime Agent requires WSL2 on native Windows. Connect to a supported environment.";

function provider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly availability?: "available" | "unavailable";
  readonly unavailableReason?: string;
  readonly status?: ServerProvider["status"];
  readonly continuationGroupKey?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.availability !== "unavailable",
    installed: true,
    version: null,
    status: input.status ?? (input.availability === "unavailable" ? "disabled" : "ready"),
    ...(input.availability ? { availability: input.availability } : {}),
    ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
    ...(input.continuationGroupKey
      ? { continuation: { groupKey: input.continuationGroupKey } }
      : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-08-06T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("ThreadComposer provider authority", () => {
  it("shows and blocks the unavailable Prime binding instead of a local Codex overlay", () => {
    const prime = provider({
      instanceId: "primeAgent",
      driver: "primeAgent",
      availability: "unavailable",
      unavailableReason: PRIME_REASON,
    });
    const codex = provider({ instanceId: "codex", driver: "codex" });

    const authority = resolveThreadComposerAuthority({
      serverConfig: { providers: [prime, codex] },
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      sessionProviderInstanceId: ProviderInstanceId.make("primeAgent"),
    });

    expect(authority.modelSelection).toBeNull();
    expect(authority.providerBindingMismatch).toBe(true);
    expect(authority.provider).toBe(prime);
    expect(authority.provider?.unavailableReason).toBe(PRIME_REASON);
    expect(authority.providerAdmissionAvailable).toBe(false);
  });

  it("keeps cold offline snapshots queueable and warning snapshots admissible", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    expect(
      resolveThreadComposerAuthority({ serverConfig: undefined, modelSelection: selection }),
    ).toMatchObject({
      modelSelection: selection,
      providerAdmissionAvailable: true,
      providerAdmissionReason: null,
    });
    expect(
      resolveThreadComposerAuthority({
        serverConfig: {
          providers: [provider({ instanceId: "codex", driver: "codex", status: "warning" })],
        },
        modelSelection: selection,
      }),
    ).toMatchObject({ providerAdmissionAvailable: true, providerAdmissionReason: null });
  });

  it("returns concrete admission reasons for every provider materialization failure", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("primeAgent"),
      model: "default",
    };
    expect(
      resolveThreadComposerAuthority({ serverConfig: { providers: [] }, modelSelection: selection })
        .providerAdmissionReason,
    ).toContain("not configured");

    const disabled = {
      ...provider({ instanceId: "primeAgent", driver: "primeAgent" }),
      enabled: false,
    };
    expect(
      resolveThreadComposerAuthority({
        serverConfig: { providers: [disabled] },
        modelSelection: selection,
      }).providerAdmissionReason,
    ).toContain("disabled");

    const uninstalled = { ...disabled, enabled: true, installed: false };
    expect(
      resolveThreadComposerAuthority({
        serverConfig: { providers: [uninstalled] },
        modelSelection: selection,
      }).providerAdmissionReason,
    ).toContain("not installed");

    const unauthenticated = {
      ...uninstalled,
      installed: true,
      auth: { status: "unauthenticated" as const },
    };
    expect(
      resolveThreadComposerAuthority({
        serverConfig: { providers: [unauthenticated] },
        modelSelection: selection,
      }).providerAdmissionReason,
    ).toContain("Sign in");
  });

  it("reports project and connection admission reasons without hiding offline queueing", () => {
    expect(
      resolveThreadComposerAdmissionReason({
        providerReason: null,
        projectCwd: null,
        connectionState: "connected",
      }),
    ).toContain("project workspace");
    expect(
      resolveThreadComposerAdmissionReason({
        providerReason: null,
        projectCwd: "/repo",
        connectionState: "offline",
      }),
    ).toContain("offline");
    expect(
      resolveThreadComposerAdmissionReason({
        providerReason: null,
        projectCwd: "/repo",
        connectionState: "connecting",
      }),
    ).toContain("connecting");
  });

  it("keeps an intact model selection owned by a compatible account", () => {
    const work = provider({
      instanceId: "codex",
      driver: "codex",
      continuationGroupKey: "codex:home:shared",
    });
    const personal = provider({
      instanceId: "codex_personal",
      driver: "codex",
      continuationGroupKey: "codex:home:shared",
    });
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    } as const;

    const authority = resolveThreadComposerAuthority({
      serverConfig: { providers: [work, personal] },
      modelSelection,
      sessionProviderInstanceId: ProviderInstanceId.make("codex"),
    });

    expect(authority.modelSelection).toBe(modelSelection);
    expect(authority.provider).toBe(personal);
    expect(authority.providerBindingMismatch).toBe(false);
    expect(authority.providerAdmissionAvailable).toBe(true);
  });

  it("keeps Stop available for an active turn when provider admission is unavailable", () => {
    expect(threadComposerShowsStopAction("running")).toBe(true);
    expect(threadComposerShowsStopAction("starting")).toBe(true);
    expect(threadComposerShowsStopAction("ready")).toBe(false);
  });
});

describe("ThreadComposer model change reasons", () => {
  const prime = provider({ instanceId: "primeAgent", driver: "primeAgent" });
  const selection = { instanceId: prime.instanceId, model: "openai/gpt-5.4" };
  const option: ModelOption = {
    key: "primeAgent:default",
    label: "Prime Agent Default",
    subtitle: "",
    providerKey: "primeAgent",
    providerLabel: "Prime Agent",
    providerDriver: "primeAgent",
    isDefault: true,
    isLegacy: false,
    capabilities: null,
    selection: { ...selection, model: "default" },
  };
  const base = {
    option,
    currentModelSelection: selection,
    session: { providerInstanceId: prime.instanceId },
    providers: [prime],
    sessionInputBlocked: false,
    modelChangesLocked: false,
  };

  it("uses the full canonical web reason for Prime Default", () => {
    const reason = getThreadComposerModelChangeDisabledReason(base);
    expect(reason).toBe(
      formatModelChangeDisabledReason(PRIME_AGENT_DEFAULT_MODEL_CHANGE_DESCRIPTION),
    );
    expect(reason).toBe(
      "Prime Agent cannot hand model choice back to its own default once a conversation is running. Start a new thread to use this model.",
    );
  });

  it.each(["modelChangesLocked", "requiresNewThreadForModelChange"] as const)(
    "explains the existing %s restriction with web copy",
    (restriction) => {
      expect(
        getThreadComposerModelChangeDisabledReason({
          ...base,
          modelChangesLocked: restriction === "modelChangesLocked",
          option: {
            ...option,
            selection: { ...selection, model: "openai/gpt-5.5" },
            requiresNewThreadForModelChange: restriction === "requiresNewThreadForModelChange",
          },
        }),
      ).toBe(formatModelChangeDisabledReason(STARTED_THREAD_MODEL_CHANGE_DESCRIPTION));
    },
  );

  it("allows Default on new threads, the current row, and supported named model changes", () => {
    expect(
      getThreadComposerModelChangeDisabledReason({
        ...base,
        session: null,
        modelChangesLocked: true,
      }),
    ).toBeUndefined();
    expect(
      getThreadComposerModelChangeDisabledReason({
        ...base,
        currentModelSelection: option.selection,
        modelChangesLocked: true,
      }),
    ).toBeUndefined();
    expect(
      getThreadComposerModelChangeDisabledReason({
        ...base,
        option: { ...option, selection: { ...selection, model: "openai/gpt-5.5" } },
      }),
    ).toBeUndefined();
  });

  it("preserves safety blocking even for the current row and new threads", () => {
    expect(
      getThreadComposerModelChangeDisabledReason({
        ...base,
        session: null,
        currentModelSelection: option.selection,
        sessionInputBlocked: true,
      }),
    ).toBe("Provider changes are blocked while this thread has a pending safety operation");
  });

  it("preserves provider runtime and account continuation guards before model-specific reasons", () => {
    const codex = provider({ instanceId: "codex", driver: "codex" });
    expect(
      getThreadComposerModelChangeDisabledReason({
        ...base,
        providers: [prime, codex],
        option: { ...option, selection: { instanceId: codex.instanceId, model: "default" } },
      }),
    ).toBe("This thread uses primeAgent. Start a new thread to change providers.");
    const other = provider({ instanceId: "prime-other", driver: "primeAgent" });
    expect(
      getThreadComposerModelChangeDisabledReason({
        ...base,
        providers: [prime, other],
        option: { ...option, selection: { instanceId: other.instanceId, model: "default" } },
      }),
    ).toContain("shared continuation identity");
  });

  it("keeps compatible account switches selectable while admission owns availability", () => {
    const work = provider({
      instanceId: "codex",
      driver: "codex",
      continuationGroupKey: "codex:shared",
    });
    const personal = provider({
      instanceId: "codex-personal",
      driver: "codex",
      continuationGroupKey: "codex:shared",
    });
    const input = {
      ...base,
      session: { providerInstanceId: work.instanceId },
      providers: [work, personal],
      currentModelSelection: { instanceId: work.instanceId, model: "gpt-5.4" },
      option: {
        ...option,
        providerDriver: "codex",
        selection: { instanceId: personal.instanceId, model: "gpt-5.4" },
      },
    };
    expect(getThreadComposerModelChangeDisabledReason(input)).toBeUndefined();
    expect(
      resolveThreadComposerAuthority({
        serverConfig: { providers: [work, { ...personal, enabled: false }] },
        modelSelection: input.option.selection,
        sessionProviderInstanceId: work.instanceId,
      }).providerAdmissionReason,
    ).toContain("disabled");
  });
});
