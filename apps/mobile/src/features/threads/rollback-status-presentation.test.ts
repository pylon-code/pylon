import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationRollbackStatus } from "@t3tools/contracts";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  getMobileRollbackStatusPresentation,
  currentMobileRollbackSessionOwner,
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
  it("uses the newer authoritative event sequence in either stream", () => {
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
    ).toEqual({ status: detail, uncertain: false });
    expect(
      resolveMobileRollbackStatus({
        detail: source(detail, 11),
        shell: source(shell, 12),
        currentSessionOwner: owner,
      }),
    ).toEqual({ status: shell, uncertain: false });
    expect(
      resolveMobileRollbackStatus({
        detail: source({ state: "completed", updatedAt }, 12),
        shell: source(shell, 13),
        currentSessionOwner: owner,
      }),
    ).toEqual({ status: shell, uncertain: false });
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
    ).toEqual({ status: newStatus, uncertain: false });
    expect(
      resolveMobileRollbackStatus({
        detail: { status: oldStatus, sequence: 100, sessionOwner: oldOwner, live: true },
        shell: { status: undefined, sequence: undefined, sessionOwner: null, live: false },
        currentSessionOwner: newOwner,
      }),
    ).toEqual({ status: undefined, uncertain: true });
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
      status: undefined,
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
          status: { state: "manual-recovery", updatedAt, allowedActions: [] },
        },
        currentSessionOwner: owner,
      }),
    ).toEqual({ status: undefined, uncertain: true });
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
