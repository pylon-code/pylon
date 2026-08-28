import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { resolveThreadStatus } from "./threadPresentation";

const baseThread = {
  interactionMode: "default",
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestTurn: null,
  session: null,
} as EnvironmentThreadShell;

describe("resolveThreadStatus", () => {
  it("uses the orange warning treatment for user input", () => {
    expect(resolveThreadStatus({ ...baseThread, hasPendingUserInput: true })).toMatchObject({
      kind: "awaiting-input",
      pillClassName: "bg-warning-surface",
      textClassName: "text-warning-foreground",
    });
  });

  it("uses the purple info role for plan-ready information", () => {
    expect(
      resolveThreadStatus({
        ...baseThread,
        interactionMode: "plan",
        hasActionableProposedPlan: true,
        latestTurn: {
          startedAt: "2026-08-27T12:00:00.000Z",
          completedAt: "2026-08-27T12:01:00.000Z",
        },
      } as EnvironmentThreadShell),
    ).toMatchObject({
      kind: "plan-ready",
      pillClassName: "bg-screen",
      textClassName: "text-status-info",
    });
  });

  it.each(["running", "starting"] as const)(
    "uses the active theme role while the session is %s",
    (status) => {
      expect(
        resolveThreadStatus({
          ...baseThread,
          session: { status },
        } as EnvironmentThreadShell),
      ).toMatchObject({
        pillClassName: "bg-screen",
        textClassName: "text-status-active",
      });
    },
  );
});
