import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationRollbackStatus } from "@t3tools/contracts";

import {
  getMobileRollbackStatusPresentation,
  resolveMobileRollbackStatus,
} from "./rollback-status-presentation";

const updatedAt = "2026-08-31T12:00:00.000Z";

describe("mobile rollback status presentation", () => {
  it("keeps the durable detail status ahead of a stale shell status", () => {
    const detail: OrchestrationRollbackStatus = {
      state: "manual-recovery",
      updatedAt,
      detail: "Restore the provider transcript, then retry verification.",
      allowedActions: ["retry-verification", "resume-compensation"],
    };
    const shell: OrchestrationRollbackStatus = { state: "pending", updatedAt };
    expect(resolveMobileRollbackStatus(detail, shell)).toBe(detail);
    expect(resolveMobileRollbackStatus(undefined, shell)).toBe(shell);
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
