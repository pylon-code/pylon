import { describe, expect, it } from "vite-plus/test";

import {
  buildSessionHarnessRefinementMenuActions,
  canRefineSessionHarness,
  parseSessionHarnessRefinementAction,
  sessionHarnessRefinementActionId,
  sessionHarnessRefinementScopeKey,
} from "./sessionHarnessRefinementMenu";

const provider = {
  featureCapabilities: {
    version: 1,
    context: {
      support: "read-write",
      operations: ["refine"],
    },
  },
} as const;

const readySession = {
  status: "ready",
  runtimeMode: "full-access",
  startedAt: "2026-01-01T00:00:00.000Z",
} as const;

describe("session harness refinement menu", () => {
  it("gates the action on the connected, full-access active session capability", () => {
    expect(
      canRefineSessionHarness({ connectionState: "connected", session: readySession, provider }),
    ).toBe(true);
    expect(
      canRefineSessionHarness({
        connectionState: "connected",
        session: { ...readySession, status: "running" },
        provider,
      }),
    ).toBe(true);

    const unavailableCases = [
      { connectionState: "offline", session: readySession, provider },
      {
        connectionState: "connected",
        session: { ...readySession, runtimeMode: "approval-required" },
        provider,
      },
      {
        connectionState: "connected",
        session: { ...readySession, status: "starting" },
        provider,
      },
      {
        connectionState: "connected",
        session: { ...readySession, restored: true },
        provider,
      },
      {
        connectionState: "connected",
        session: { status: "ready", runtimeMode: "full-access" },
        provider,
      },
      {
        connectionState: "connected",
        session: readySession,
        provider: {
          featureCapabilities: {
            version: 1,
            context: { support: "read-write", operations: ["observe"] },
          },
        },
      },
      {
        connectionState: "connected",
        session: readySession,
        provider: {
          featureCapabilities: {
            version: 1,
            context: { support: "read-only", operations: ["refine"] },
          },
        },
      },
      { connectionState: "connected", session: readySession, provider: null },
    ] as const satisfies ReadonlyArray<Parameters<typeof canRefineSessionHarness>[0]>;
    for (const input of unavailableCases) {
      expect(canRefineSessionHarness(input)).toBe(false);
    }
  });

  it("changes scope across same-thread provider session restarts", () => {
    const base = {
      environmentId: "environment",
      threadId: "thread",
      providerInstanceId: "provider",
    } as const;
    expect(
      sessionHarnessRefinementScopeKey({
        ...base,
        sessionStartedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).not.toBe(
      sessionHarnessRefinementScopeKey({
        ...base,
        sessionStartedAt: "2026-01-01T00:00:01.000Z",
      }),
    );
  });

  it("builds one provider-neutral scoped action and disables it while pending", () => {
    const scopeKey = "environment:thread:provider/instance";
    const eventId = sessionHarnessRefinementActionId(scopeKey);
    const [action] = buildSessionHarnessRefinementMenuActions({
      scopeKey,
      connectionState: "connected",
      session: { ...readySession, harnessRefinementStatus: "running" },
      provider,
      pendingScopeKey: null,
      outcomeUnknownScopeKey: null,
    });

    expect(action).toMatchObject({
      id: eventId,
      title: "Refining local harness…",
      subtitle: expect.stringContaining("only this thread's session harness"),
      attributes: { disabled: true },
    });
    expect(parseSessionHarnessRefinementAction(eventId, scopeKey)).toBe("refine");
    expect(parseSessionHarnessRefinementAction(eventId, "other-scope")).toBeNull();
    expect(JSON.stringify(action)).not.toMatch(/prime|daemon|native|instruction/i);

    const [unknownAction] = buildSessionHarnessRefinementMenuActions({
      scopeKey,
      connectionState: "connected",
      session: { ...readySession, harnessRefinementStatus: "outcome-unknown" },
      provider,
      pendingScopeKey: null,
      outcomeUnknownScopeKey: null,
    });
    expect(unknownAction).toMatchObject({
      title: "Refinement outcome unavailable",
      attributes: { disabled: true },
    });
  });

  it("omits the action when the active session is not eligible", () => {
    expect(
      buildSessionHarnessRefinementMenuActions({
        scopeKey: null,
        connectionState: "connected",
        session: readySession,
        provider,
        pendingScopeKey: null,
        outcomeUnknownScopeKey: null,
      }),
    ).toEqual([]);
  });
});
