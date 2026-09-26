import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationRollbackStatus } from "@t3tools/contracts";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  getMobileRollbackStatusPresentation,
  currentMobileRollbackSessionOwner,
  mobileRollbackDetailIsCurrent,
  resolveMobileRollbackStatus,
} from "./rollback-status-presentation";

const updatedAt = "2026-08-31T12:00:00.000Z";

describe("mobile rollback status presentation", () => {
  it("rejects a waiting or disconnected catalog result even when it retains an old owner", () => {
    const owner = {};
    const connected = {
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
      sessionOwner: owner,
    };
    expect(currentMobileRollbackSessionOwner(AsyncResult.success(connected))).toBe(owner);
    expect(
      currentMobileRollbackSessionOwner(AsyncResult.waiting(AsyncResult.success(connected))),
    ).toBeNull();
    expect(
      currentMobileRollbackSessionOwner(AsyncResult.success({ ...connected, phase: "connecting" })),
    ).toBeNull();
  });
  it("shows the newer status in either stream but holds actions until projections agree", () => {
    const owner = {};
    const detail: OrchestrationRollbackStatus = {
      state: "manual-recovery",
      updatedAt,
      detail: "Restore the provider transcript, then retry verification.",
      allowedActions: ["retry-verification", "resume-compensation"],
    };
    const shell: OrchestrationRollbackStatus = { state: "pending", updatedAt };
    const source = (status: OrchestrationRollbackStatus, sequence: number) => ({
      status,
      sequence,
      sessionOwner: owner,
      live: true,
    });
    expect(
      resolveMobileRollbackStatus({
        detail: source(detail, 12),
        shell: source(shell, 11),
        currentSessionOwner: owner,
      }),
    ).toEqual({ status: { ...detail, allowedActions: [] }, uncertain: true });
    expect(
      resolveMobileRollbackStatus({
        detail: source(detail, 11),
        shell: source(shell, 12),
        currentSessionOwner: owner,
      }),
    ).toEqual({ status: { ...shell, allowedActions: [] }, uncertain: true });
    expect(
      resolveMobileRollbackStatus({
        detail: source({ state: "completed", updatedAt }, 12),
        shell: source(shell, 13),
        currentSessionOwner: owner,
      }),
    ).toEqual({ status: { ...shell, allowedActions: [] }, uncertain: true });
  });

  it("retains rich detail through unrelated shell sequence progress when operation tokens agree", () => {
    const owner = {};
    const detail = {
      state: "manual-recovery" as const,
      updatedAt,
      operationId: "rollback-a",
      detail: "Repair the provider transcript.",
      allowedActions: ["retry-verification" as const],
    };
    const shell = { state: "manual-recovery" as const, updatedAt, operationId: "rollback-a" };
    expect(
      resolveMobileRollbackStatus({
        detail: { status: detail, sequence: 12, sessionOwner: owner, live: true },
        shell: { status: shell, sequence: 30, sessionOwner: owner, live: true },
        currentSessionOwner: owner,
      }),
    ).toEqual({ status: detail, uncertain: false });
    const legacyDetail = {
      state: "manual-recovery" as const,
      updatedAt,
      detail: "Repair the provider transcript.",
      allowedActions: ["retry-verification" as const],
    };
    expect(
      resolveMobileRollbackStatus({
        detail: { status: legacyDetail, sequence: 12, sessionOwner: owner, live: true },
        shell: {
          status: { state: "manual-recovery", updatedAt },
          sequence: 30,
          sessionOwner: owner,
          live: true,
        },
        currentSessionOwner: owner,
      }),
    ).toEqual({
      status: { ...legacyDetail, allowedActions: [] },
      uncertain: false,
    });
    const otherOperationShell = { ...shell, operationId: "rollback-b" };
    expect(
      resolveMobileRollbackStatus({
        detail: { status: detail, sequence: 12, sessionOwner: owner, live: true },
        shell: {
          status: otherOperationShell,
          sequence: 30,
          sessionOwner: owner,
          live: true,
        },
        currentSessionOwner: owner,
      }),
    ).toEqual({
      status: { ...shell, operationId: "rollback-b", allowedActions: [] },
      uncertain: true,
    });
  });

  it("rejects an old session after replacement even when its sequence is higher", () => {
    const oldOwner = {};
    const newOwner = {};
    const oldStatus: OrchestrationRollbackStatus = { state: "completed", updatedAt };
    const newStatus: OrchestrationRollbackStatus = { state: "manual-recovery", updatedAt };
    expect(
      resolveMobileRollbackStatus({
        detail: { status: oldStatus, sequence: 100, sessionOwner: oldOwner, live: true },
        shell: { status: newStatus, sequence: 1, sessionOwner: newOwner, live: true },
        currentSessionOwner: newOwner,
      }),
    ).toEqual({ status: { ...newStatus, allowedActions: [] }, uncertain: true });
    expect(
      resolveMobileRollbackStatus({
        detail: { status: oldStatus, sequence: 100, sessionOwner: oldOwner, live: true },
        shell: { status: undefined, sequence: undefined, sessionOwner: null, live: false },
        currentSessionOwner: newOwner,
      }),
    ).toEqual({ status: undefined, uncertain: true });
  });

  it("blocks stale detail targets and sends while a replacement shell is the only current view", () => {
    const oldOwner = {};
    const newOwner = {};
    const oldDetail = {
      status: { state: "completed" as const, updatedAt },
      sequence: 99,
      sessionOwner: oldOwner,
      live: true,
    };
    const newShell = {
      status: null,
      sequence: 1,
      sessionOwner: newOwner,
      live: true,
    };
    const resolved = resolveMobileRollbackStatus({
      detail: oldDetail,
      shell: newShell,
      currentSessionOwner: newOwner,
      rollbackStatusStreaming: true,
    });
    expect(resolved).toEqual({ status: null, uncertain: true });
    expect(
      resolveMobileRollbackStatus({
        detail: oldDetail,
        shell: newShell,
        currentSessionOwner: newOwner,
        rollbackStatusStreaming: false,
      }).uncertain,
    ).toBe(true);
    expect(
      mobileRollbackDetailIsCurrent({
        detail: oldDetail,
        currentSessionOwner: newOwner,
        uncertain: resolved.uncertain,
      }),
    ).toBe(false);
    expect(
      resolveMobileRollbackStatus({
        detail: { ...newShell, status: { state: "pending", updatedAt } },
        shell: { ...oldDetail, status: null },
        currentSessionOwner: newOwner,
        rollbackStatusStreaming: true,
      }).uncertain,
    ).toBe(true);
  });

  it("allows an old peer's fresh no-status view without waiting for unsupported metadata", () => {
    const owner = {};
    const detail = { status: null, sequence: 5, sessionOwner: owner, live: true };
    const resolved = resolveMobileRollbackStatus({
      detail,
      shell: { status: undefined, sequence: undefined, sessionOwner: null, live: false },
      currentSessionOwner: owner,
      rollbackStatusStreaming: false,
    });
    expect(resolved).toEqual({ status: null, uncertain: false });
    expect(
      mobileRollbackDetailIsCurrent({
        detail,
        currentSessionOwner: owner,
        uncertain: resolved.uncertain,
      }),
    ).toBe(true);
  });

  it("fails closed on same-sequence disagreement and preserves old-peer absence", () => {
    const owner = {};
    const detail = {
      status: { state: "completed" as const, updatedAt },
      sequence: 15,
      sessionOwner: owner,
      live: true,
    };
    const shell = {
      status: { state: "pending" as const, updatedAt },
      sequence: 15,
      sessionOwner: owner,
      live: true,
    };
    expect(resolveMobileRollbackStatus({ detail, shell, currentSessionOwner: owner })).toEqual({
      status: { ...shell.status, allowedActions: [] },
      uncertain: true,
    });
    expect(
      resolveMobileRollbackStatus({
        detail: {
          ...detail,
          status: { state: "manual-recovery", updatedAt, allowedActions: ["retry-verification"] },
        },
        shell: {
          ...shell,
          status: { state: "manual-recovery", updatedAt },
        },
        currentSessionOwner: owner,
      }),
    ).toEqual({
      status: {
        state: "manual-recovery",
        updatedAt,
        allowedActions: [],
      },
      uncertain: false,
    });
    expect(
      resolveMobileRollbackStatus({
        detail: { ...detail, status: undefined },
        shell: { ...shell, status: undefined },
        currentSessionOwner: owner,
      }),
    ).toEqual({ status: undefined, uncertain: false });
  });

  it("announces progress politely and manual recovery assertively with exact actions", () => {
    expect(getMobileRollbackStatusPresentation({ state: "recovering", updatedAt })).toMatchObject({
      title: "Rollback recovering",
      severe: false,
      accessibilityRole: "summary",
      accessibilityLiveRegion: "polite",
      actions: [],
    });

    expect(
      getMobileRollbackStatusPresentation({
        state: "manual-recovery",
        updatedAt,
        detail: "Manual repair is required.",
        allowedActions: ["retry-verification", "resume-compensation"],
      }),
    ).toEqual({
      title: "Manual recovery required",
      detail: "Manual repair is required.",
      severe: true,
      accessibilityRole: "alert",
      accessibilityLiveRegion: "assertive",
      actions: ["retry-verification", "resume-compensation"],
    });
  });
});
