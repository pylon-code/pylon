import { describe, expect, it } from "vite-plus/test";

import {
  canRefineSessionHarness,
  harnessRefinementToast,
  isCurrentSessionHarnessRefinementRequest,
  sessionHarnessRefinementControlState,
  sessionHarnessRefinementScopeKey,
  SESSION_HARNESS_REFINEMENT_CONFIRMATION,
} from "./sessionHarnessRefinement";

const provider = {
  status: "ready" as const,
  featureCapabilities: {
    version: 1,
    context: { support: "read-write" as const, operations: ["refine"] as const },
  },
};

const availableSession = {
  provider,
  hasActiveThread: true,
  runtimeMode: "full-access" as const,
  sessionStatus: "ready",
  isConnecting: false,
  environmentAvailable: true,
  restored: false,
  sessionStartedAt: "2026-01-01T00:00:00.000Z",
};

describe("local session harness refinement", () => {
  it("requires a connected full-access session and the advertised refine operation", () => {
    expect(canRefineSessionHarness(availableSession)).toBe(true);
    expect(canRefineSessionHarness({ ...availableSession, runtimeMode: "approval-required" })).toBe(
      false,
    );
    expect(canRefineSessionHarness({ ...availableSession, sessionStatus: "starting" })).toBe(false);
    expect(canRefineSessionHarness({ ...availableSession, isConnecting: true })).toBe(false);
    expect(
      canRefineSessionHarness({
        ...availableSession,
        provider: { ...provider, status: "warning" },
      }),
    ).toBe(false);
    expect(canRefineSessionHarness({ ...availableSession, environmentAvailable: false })).toBe(
      false,
    );
    expect(canRefineSessionHarness({ ...availableSession, restored: true })).toBe(false);
    expect(canRefineSessionHarness({ ...availableSession, sessionStartedAt: null })).toBe(false);
    expect(
      canRefineSessionHarness({
        ...availableSession,
        provider: {
          status: "ready",
          featureCapabilities: {
            version: 1,
            context: { support: "read-write", operations: ["observe"] },
          },
        },
      }),
    ).toBe(false);
  });

  it("rejects stale completions after a thread or provider switch", () => {
    const request = { scopeKey: "environment:thread:provider-a", id: 7 };
    expect(isCurrentSessionHarnessRefinementRequest(request.scopeKey, request.id, request)).toBe(
      true,
    );
    expect(
      isCurrentSessionHarnessRefinementRequest(
        "environment:thread:provider-b",
        request.id,
        request,
      ),
    ).toBe(false);
    expect(
      isCurrentSessionHarnessRefinementRequest(request.scopeKey, request.id + 1, request),
    ).toBe(false);
  });

  it("retains projected running and outcome-unknown barriers across client mounts", () => {
    expect(
      sessionHarnessRefinementControlState({
        lifecycle: "running",
        locallyPending: false,
        locallyOutcomeUnknown: false,
      }),
    ).toEqual({ pending: true, outcomeUnknown: false, canRefine: false });
    expect(
      sessionHarnessRefinementControlState({
        lifecycle: "outcome-unknown",
        locallyPending: false,
        locallyOutcomeUnknown: false,
      }),
    ).toEqual({ pending: false, outcomeUnknown: true, canRefine: false });
  });

  it("changes scope when the same thread and provider start a new session incarnation", () => {
    const first = sessionHarnessRefinementScopeKey({
      sessionScopeKey: "environment:thread:provider",
      sessionStartedAt: "2026-01-01T00:00:00.000Z",
    });
    const restarted = sessionHarnessRefinementScopeKey({
      sessionScopeKey: "environment:thread:provider",
      sessionStartedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(first).not.toBe(restarted);
    expect(first).not.toBeNull();
    expect(
      isCurrentSessionHarnessRefinementRequest(restarted, 1, {
        scopeKey: first!,
        id: 1,
      }),
    ).toBe(false);
  });

  it("requires an explicit confirmation that describes the irreversible private operation", () => {
    expect(SESSION_HARNESS_REFINEMENT_CONFIRMATION).toContain(
      "this thread's private session harness",
    );
    expect(SESSION_HARNESS_REFINEMENT_CONFIRMATION).toContain("may take time");
    expect(SESSION_HARNESS_REFINEMENT_CONFIRMATION).toContain(
      "cannot be cancelled or rolled back here",
    );
  });

  it("uses generic, privacy-safe toast copy for each sanitized outcome", () => {
    expect(harnessRefinementToast("completed")).toMatchObject({ type: "success" });
    expect(harnessRefinementToast("partial")).toMatchObject({ type: "warning" });
    expect(harnessRefinementToast("failed")).toMatchObject({ type: "error" });
    expect(harnessRefinementToast("unknown")).toMatchObject({ type: "warning" });
    expect(
      JSON.stringify([
        harnessRefinementToast("completed"),
        harnessRefinementToast("partial"),
        harnessRefinementToast("failed"),
        harnessRefinementToast("unknown"),
      ]),
    ).not.toMatch(/path|native|identifier|edit|count/i);
  });
});
