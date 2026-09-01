import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadComposerAdmissionReason,
  resolveThreadComposerAuthority,
  threadComposerShowsStopAction,
} from "./ThreadComposer.logic";

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
