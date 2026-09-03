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
  it("restores distinct upstream approval and input hues", () => {
    expect(resolveThreadStatus({ ...baseThread, hasPendingApprovals: true })).toMatchObject({
      kind: "pending-approval",
      pillClassName: "bg-adaptive-amber-500-a12-a16",
      textClassName: "text-adaptive-amber-700-300",
      iconColor: "#ff9f0a",
    });
    expect(resolveThreadStatus({ ...baseThread, hasPendingUserInput: true })).toMatchObject({
      kind: "awaiting-input",
      pillClassName: "bg-adaptive-indigo-500-a12-a16",
      textClassName: "text-adaptive-indigo-700-300",
      iconColor: "#5e5ce6",
    });
  });

  it("uses the upstream violet plan-ready treatment", () => {
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
      pillClassName: "bg-adaptive-violet-500-a12-a16",
      textClassName: "text-adaptive-violet-700-300",
      iconColor: "#bf5af2",
    });
  });

  it.each(["running", "starting"] as const)(
    "uses upstream sky while the session is %s",
    (status) => {
      expect(
        resolveThreadStatus({
          ...baseThread,
          session: { status },
        } as EnvironmentThreadShell),
      ).toMatchObject({
        pillClassName: "bg-adaptive-sky-500-a12-a16",
        textClassName: "text-adaptive-sky-700-300",
        iconColor: "#0a84ff",
        pulse: true,
      });
    },
  );
});
