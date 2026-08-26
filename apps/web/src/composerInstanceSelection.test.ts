import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveComposerInstanceSelection } from "./composerInstanceSelection";
import { deriveProviderInstanceEntries, NO_PROVIDER_MODEL_SELECTION } from "./providerInstances";

const NOW_MS = Date.parse("2026-08-06T12:00:00.000Z");

function provider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled?: boolean;
  readonly status?: ServerProvider["status"];
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
  // The picker's unsaved pick must win, or the UI appears to ignore it.
  it("prefers the draft's picker choice over the thread's binding", () => {
    const selection = resolveComposerInstanceSelection({
      ...base,
      entries: entriesOf(CLAUDE_WORK, CLAUDE_PERSONAL, CODEX),
      draftActiveProvider: id("codex"),
      sessionInstanceId: id("claudeAgent"),
    });

    expect(selection.instanceId).toBe("codex");
    expect(selection.driverKind).toBe("codex");
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

  it("stays inside the locked continuation group", () => {
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
    expect(selection.instanceId).toBe("claude_work_2");
  });

  it("reports no provider when nothing is selectable", () => {
    const selection = resolveComposerInstanceSelection({ ...base, entries: [] });

    expect(selection.instanceId).toBe(NO_PROVIDER_MODEL_SELECTION.instanceId);
    expect(selection.entry).toBeUndefined();
    expect(selection.driverKind).toBe("unconfigured");
  });
});
