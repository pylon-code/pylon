import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canStartComposerTurn,
  resolveComposerInstanceSelection,
} from "./composerInstanceSelection";
import { deriveProviderInstanceEntries, NO_PROVIDER_MODEL_SELECTION } from "./providerInstances";

const NOW_MS = Date.parse("2026-08-06T12:00:00.000Z");

function provider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled?: boolean;
  readonly status?: ServerProvider["status"];
  readonly availability?: ServerProvider["availability"];
  readonly unavailableReason?: string;
  readonly continuationGroupKey?: string;
  readonly drainedUntil?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-08-06T11:59:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.continuationGroupKey
      ? { continuation: { groupKey: input.continuationGroupKey } }
      : {}),
    ...(input.drainedUntil
      ? {
          rateLimit: {
            status: "rejected" as const,
            resetsAt: input.drainedUntil,
            observedAt: "2026-08-06T11:00:00.000Z",
          },
        }
      : {}),
  };
}

const id = (value: string) => ProviderInstanceId.make(value);
const kind = (value: string) => ProviderDriverKind.make(value);

const CLAUDE_WORK = provider({ instanceId: "claudeAgent", driver: "claudeAgent" });
const CLAUDE_PERSONAL = provider({ instanceId: "claude_personal", driver: "claudeAgent" });
const CODEX = provider({ instanceId: "codex", driver: "codex" });
const PRIME_UNAVAILABLE_REASON =
  "Prime Agent cannot materialize on this Pylon server. Choose another provider or connect to a supported environment.";
const PRIME_UNAVAILABLE = provider({
  instanceId: "primeAgent",
  driver: "primeAgent",
  enabled: false,
  status: "disabled",
  availability: "unavailable",
  unavailableReason: PRIME_UNAVAILABLE_REASON,
});

const entriesOf = (...providers: ServerProvider[]) => deriveProviderInstanceEntries(providers);

const base = {
  draftActiveProvider: null,
  sessionInstanceId: null,
  threadInstanceId: null,
  projectInstanceId: null,
  lockedProvider: null,
  nowMs: NOW_MS,
} as const;

describe("resolveComposerInstanceSelection", () => {
  it("keeps the live session authoritative over a stale device draft", () => {
    const selection = resolveComposerInstanceSelection({
      ...base,
      entries: entriesOf(CLAUDE_WORK, CLAUDE_PERSONAL, CODEX),
      draftActiveProvider: id("codex"),
      sessionInstanceId: id("claudeAgent"),
    });

    expect(selection.instanceId).toBe("claudeAgent");
    expect(selection.driverKind).toBe("claudeAgent");
    expect(selection.draftConflictsWithSessionBinding).toBe(true);
  });

  it("keeps an explicit same-driver exact-continuation account choice", () => {
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
    const selection = resolveComposerInstanceSelection({
      ...base,
      entries: entriesOf(work, personal),
      draftActiveProvider: id("codex_personal"),
      sessionInstanceId: id("codex"),
      lockedProvider: kind("codex"),
    });

    expect(selection.instanceId).toBe("codex_personal");
    expect(selection.entry?.instanceId).toBe("codex_personal");
    expect(selection.draftConflictsWithSessionBinding).toBe(false);
    expect(canStartComposerTurn(selection)).toBe(true);
  });

  it("falls through thread, then project, when nothing was picked", () => {
    const entries = entriesOf(CLAUDE_WORK, CLAUDE_PERSONAL, CODEX);

    expect(
      resolveComposerInstanceSelection({
        ...base,
        entries,
        threadInstanceId: id("claude_personal"),
        projectInstanceId: id("codex"),
      }).instanceId,
    ).toBe("claude_personal");
    expect(
      resolveComposerInstanceSelection({ ...base, entries, projectInstanceId: id("codex") })
        .instanceId,
    ).toBe("codex");
  });

  it.each([
    ["stored default", { draftActiveProvider: id("primeAgent") }],
    ["project default", { projectInstanceId: id("primeAgent") }],
    ["persisted thread", { threadInstanceId: id("primeAgent") }],
    ["live thread session", { sessionInstanceId: id("primeAgent") }],
  ] as const)(
    "holds an unavailable Prime %s instead of routing to ready Codex",
    (_label, source) => {
      const selection = resolveComposerInstanceSelection({
        ...base,
        entries: entriesOf(PRIME_UNAVAILABLE, CODEX),
        ...source,
      });

      expect(selection).toMatchObject({
        instanceId: "primeAgent",
        driverKind: "primeAgent",
        requestedDriverKind: "primeAgent",
        blockedByUnavailablePreference: true,
      });
      expect(selection.entry?.snapshot.unavailableReason).toBe(PRIME_UNAVAILABLE_REASON);
      expect(selection.entry?.snapshot.availability).toBe("unavailable");
      expect(canStartComposerTurn(selection)).toBe(false);
    },
  );

  it("unlocks only after an explicit provider selection", () => {
    const selection = resolveComposerInstanceSelection({
      ...base,
      entries: entriesOf(PRIME_UNAVAILABLE, CODEX),
      draftActiveProvider: id("codex"),
      threadInstanceId: id("primeAgent"),
      projectInstanceId: id("primeAgent"),
    });

    expect(selection).toMatchObject({
      instanceId: "codex",
      driverKind: "codex",
      blockedByUnavailablePreference: false,
    });
    expect(selection.entry?.snapshot).toBe(CODEX);
    expect(canStartComposerTurn(selection)).toBe(true);
  });

  it.each([
    ["warning", true],
    ["error", false],
  ] as const)(
    "treats a %s provider snapshot as the matching admission state",
    (status, admitted) => {
      const selection = resolveComposerInstanceSelection({
        ...base,
        entries: entriesOf(provider({ instanceId: "codex", driver: "codex", status })),
        projectInstanceId: id("codex"),
      });

      expect(canStartComposerTurn(selection)).toBe(admitted);
    },
  );

  it("unlocks the stored Prime selection when its provider becomes available", () => {
    const primeAvailable = provider({ instanceId: "primeAgent", driver: "primeAgent" });
    const selection = resolveComposerInstanceSelection({
      ...base,
      entries: entriesOf(primeAvailable, CODEX),
      projectInstanceId: id("primeAgent"),
    });

    expect(selection).toMatchObject({
      instanceId: "primeAgent",
      driverKind: "primeAgent",
      blockedByUnavailablePreference: false,
    });
    expect(selection.entry?.snapshot).toBe(primeAvailable);
    expect(canStartComposerTurn(selection)).toBe(true);
  });

  // A drained account is only routed around while nothing is pinned to it.
  it("routes an unpinned selection around a drained account", () => {
    const drained = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      drainedUntil: "2026-08-06T15:00:00.000Z",
    });
    const selection = resolveComposerInstanceSelection({
      ...base,
      entries: entriesOf(drained, CLAUDE_PERSONAL),
      projectInstanceId: id("claudeAgent"),
    });

    expect(selection.instanceId).toBe("claude_personal");
  });

  it("keeps a started thread on its drained account", () => {
    const drained = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      drainedUntil: "2026-08-06T15:00:00.000Z",
    });
    const selection = resolveComposerInstanceSelection({
      ...base,
      entries: entriesOf(drained, CLAUDE_PERSONAL),
      sessionInstanceId: id("claudeAgent"),
    });

    expect(selection.instanceId).toBe("claudeAgent");
  });

  it("skips a disabled instance and picks one of the requested kind", () => {
    const disabled = provider({ instanceId: "claudeAgent", driver: "claudeAgent", enabled: false });
    const selection = resolveComposerInstanceSelection({
      ...base,
      entries: entriesOf(disabled, CLAUDE_PERSONAL, CODEX),
      threadInstanceId: id("claudeAgent"),
    });

    expect(selection.instanceId).toBe("claude_personal");
    expect(selection.requestedDriverKind).toBe("claudeAgent");
    expect(selection.blockedByUnavailablePreference).toBe(false);
  });

  // Once locked, a persisted id from another driver or continuation group
  // is not a valid target for this thread.
  it("ignores a picker choice outside the locked driver", () => {
    const selection = resolveComposerInstanceSelection({
      ...base,
      entries: entriesOf(CLAUDE_WORK, CODEX),
      draftActiveProvider: id("codex"),
      sessionInstanceId: id("claudeAgent"),
      lockedProvider: kind("claudeAgent"),
    });

    expect(selection.instanceId).toBe("claudeAgent");
  });

  it("never falls across instances inside a locked continuation group", () => {
    const work = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      continuationGroupKey: "org-a",
      enabled: false,
    });
    const workSibling = provider({
      instanceId: "claude_work_2",
      driver: "claudeAgent",
      continuationGroupKey: "org-a",
    });
    const personal = provider({
      instanceId: "claude_personal",
      driver: "claudeAgent",
      continuationGroupKey: "org-b",
    });
    const selection = resolveComposerInstanceSelection({
      ...base,
      entries: entriesOf(work, personal, workSibling),
      sessionInstanceId: id("claudeAgent"),
      lockedProvider: kind("claudeAgent"),
    });

    expect(selection.lockedContinuationGroupKey).toBe("org-a");
    expect(selection.instanceId).toBe("claudeAgent");
    expect(canStartComposerTurn(selection)).toBe(false);
  });

  it("reports no provider when nothing is selectable", () => {
    const selection = resolveComposerInstanceSelection({ ...base, entries: [] });

    expect(selection.instanceId).toBe(NO_PROVIDER_MODEL_SELECTION.instanceId);
    expect(selection.entry).toBeUndefined();
    expect(selection.driverKind).toBe("unconfigured");
    expect(canStartComposerTurn(selection)).toBe(false);
  });
});
