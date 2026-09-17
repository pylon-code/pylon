import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, TurnId, ProviderInstanceId } from "@t3tools/contracts";
import type {
  AgentAwarenessState,
  ProjectThreadAwarenessInput,
} from "@t3tools/shared/agentAwareness";

import {
  type AwarenessNotificationPreferences,
  projectAwarenessStates,
  reconcileAwarenessNotifications,
} from "./awarenessNotifications.logic";

const allOn: AwarenessNotificationPreferences = {
  enabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

function makeState(
  overrides: Partial<Omit<AgentAwarenessState, "threadId">> & { threadId: string },
): AgentAwarenessState {
  return {
    environmentId: EnvironmentId.make("env-1"),
    projectTitle: "Pylon",
    threadTitle: "Fix the sidebar",
    phase: "running",
    headline: "Agent is working",
    modelTitle: "some-model",
    updatedAt: "2026-09-08T00:00:00.000Z",
    deepLink: `/threads/env-1/${overrides.threadId}`,
    ...overrides,
    threadId: ThreadId.make(overrides.threadId),
  };
}

describe("reconcileAwarenessNotifications", () => {
  it("primes on first snapshot without notifying", () => {
    const { notifications, nextPhases } = reconcileAwarenessNotifications({
      previousPhases: new Map(),
      states: [makeState({ threadId: "t1", phase: "completed", headline: "Agent finished" })],
      preferences: allOn,
    });
    expect(notifications).toEqual([]);
    expect(nextPhases.get("env-1:t1")).toBe("completed");
  });

  it("produces nothing when a reconnect replays unchanged phases", () => {
    const primed = new Map([["env-1:t1", "completed" as const]]);
    const { notifications } = reconcileAwarenessNotifications({
      previousPhases: primed,
      states: [makeState({ threadId: "t1", phase: "completed", headline: "Agent finished" })],
      preferences: allOn,
    });
    expect(notifications).toEqual([]);
  });

  it("fires on entry into each notifiable phase", () => {
    for (const [phase, headline] of [
      ["waiting_for_approval", "Approval needed"],
      ["waiting_for_input", "Waiting for input"],
      ["completed", "Agent finished"],
      ["failed", "Agent failed"],
    ] as const) {
      const { notifications } = reconcileAwarenessNotifications({
        previousPhases: new Map([["env-1:t1", "running" as const]]),
        states: [makeState({ threadId: "t1", phase, headline })],
        preferences: allOn,
      });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        environmentId: "env-1",
        threadId: "t1",
        title: "Fix the sidebar — Pylon",
        body: headline,
      });
    }
  });

  it("never fires for starting, running, or stale", () => {
    for (const phase of ["starting", "running", "stale"] as const) {
      const { notifications } = reconcileAwarenessNotifications({
        previousPhases: new Map([["env-1:t1", "completed" as const]]),
        states: [makeState({ threadId: "t1", phase })],
        preferences: allOn,
      });
      expect(notifications).toEqual([]);
    }
  });

  it("fires once per phase entry, not per update within a phase", () => {
    const first = reconcileAwarenessNotifications({
      previousPhases: new Map([["env-1:t1", "running" as const]]),
      states: [
        makeState({ threadId: "t1", phase: "waiting_for_approval", headline: "Approval needed" }),
      ],
      preferences: allOn,
    });
    const second = reconcileAwarenessNotifications({
      previousPhases: first.nextPhases,
      states: [
        makeState({ threadId: "t1", phase: "waiting_for_approval", headline: "Approval needed" }),
      ],
      preferences: allOn,
    });
    expect(first.notifications).toHaveLength(1);
    expect(second.notifications).toEqual([]);
  });

  it("fires again when a thread re-enters waiting_for_approval after running", () => {
    const approvedOnce = new Map([["env-1:t1", "waiting_for_approval" as const]]);
    const ran = reconcileAwarenessNotifications({
      previousPhases: approvedOnce,
      states: [makeState({ threadId: "t1", phase: "running" })],
      preferences: allOn,
    });
    const askedAgain = reconcileAwarenessNotifications({
      previousPhases: ran.nextPhases,
      states: [
        makeState({ threadId: "t1", phase: "waiting_for_approval", headline: "Approval needed" }),
      ],
      preferences: allOn,
    });
    expect(ran.notifications).toEqual([]);
    expect(askedAgain.notifications).toHaveLength(1);
  });

  it("a thread first appearing mid-session primes silently and drops from the map when gone", () => {
    const existing = new Map([["env-1:t1", "running" as const]]);
    const appeared = reconcileAwarenessNotifications({
      previousPhases: existing,
      states: [
        makeState({ threadId: "t1", phase: "running" }),
        makeState({ threadId: "t2", phase: "completed", headline: "Agent finished" }),
      ],
      preferences: allOn,
    });
    expect(appeared.notifications).toEqual([]);
    const removed = reconcileAwarenessNotifications({
      previousPhases: appeared.nextPhases,
      states: [makeState({ threadId: "t1", phase: "running" })],
      preferences: allOn,
    });
    expect(removed.nextPhases.has("env-1:t2")).toBe(false);
  });

  it("each toggle gates only its own phase; the master switch suppresses all", () => {
    const previous = new Map([["env-1:t1", "running" as const]]);
    const completedState = [
      makeState({ threadId: "t1", phase: "completed", headline: "Agent finished" }),
    ];
    expect(
      reconcileAwarenessNotifications({
        previousPhases: previous,
        states: completedState,
        preferences: { ...allOn, notifyOnCompletion: false },
      }).notifications,
    ).toEqual([]);
    const failedState = [makeState({ threadId: "t1", phase: "failed", headline: "Agent failed" })];
    expect(
      reconcileAwarenessNotifications({
        previousPhases: previous,
        states: failedState,
        preferences: { ...allOn, notifyOnCompletion: false },
      }).notifications,
    ).toHaveLength(1);
    expect(
      reconcileAwarenessNotifications({
        previousPhases: previous,
        states: failedState,
        preferences: { ...allOn, enabled: false },
      }).notifications,
    ).toEqual([]);
  });

  it("still records phases while suppressed, so enabling later never replays", () => {
    const suppressed = reconcileAwarenessNotifications({
      previousPhases: new Map([["env-1:t1", "running" as const]]),
      states: [makeState({ threadId: "t1", phase: "completed", headline: "Agent finished" })],
      preferences: { ...allOn, enabled: false },
    });
    expect(suppressed.nextPhases.get("env-1:t1")).toBe("completed");
    const enabledLater = reconcileAwarenessNotifications({
      previousPhases: suppressed.nextPhases,
      states: [makeState({ threadId: "t1", phase: "completed", headline: "Agent finished" })],
      preferences: allOn,
    });
    expect(enabledLater.notifications).toEqual([]);
  });

  it("appends detail to the body when present", () => {
    const { notifications } = reconcileAwarenessNotifications({
      previousPhases: new Map([["env-1:t1", "running" as const]]),
      states: [
        makeState({
          threadId: "t1",
          phase: "failed",
          headline: "Agent failed",
          detail: "provider exited with code 1",
        }),
      ],
      preferences: allOn,
    });
    expect(notifications[0]?.body).toBe("Agent failed — provider exited with code 1");
  });
});

describe("projectAwarenessStates (real phase cascade)", () => {
  // Shell fixtures use only the fields ProjectThreadAwarenessInput picks.
  const baseThread: ProjectThreadAwarenessInput["thread"] & { projectId: string } = {
    id: ThreadId.make("t1"),
    title: "Fix the sidebar",
    projectId: "p1",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "some-model" },
    updatedAt: "2026-09-08T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: null,
    session: null,
  };
  const titles = new Map([["env-1:p1", "Pylon"]]);
  const session = (
    status: NonNullable<ProjectThreadAwarenessInput["thread"]["session"]>["status"],
  ): NonNullable<ProjectThreadAwarenessInput["thread"]["session"]> => ({
    threadId: ThreadId.make("t1"),
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: baseThread.updatedAt,
  });
  const turn = (
    state: "running" | "completed",
  ): NonNullable<ProjectThreadAwarenessInput["thread"]["latestTurn"]> => ({
    turnId: TurnId.make("turn-1"),
    state,
    requestedAt: baseThread.updatedAt,
    startedAt: baseThread.updatedAt,
    completedAt: state === "completed" ? "2026-09-08T00:01:00.000Z" : null,
    assistantMessageId: null,
  });

  it("a session flicker running -> ready while the turn is still running is not a completion", () => {
    const running = {
      ...baseThread,
      session: session("running"),
      latestTurn: turn("running"),
    };
    const flicker = { ...running, session: session("ready") };
    const states = projectAwarenessStates({
      threads: [{ environmentId: EnvironmentId.make("env-1"), ...flicker }],
      projectTitleByKey: titles,
    });
    // latestTurn.state === "running" outranks session ready in the cascade.
    expect(states[0]?.phase).toBe("running");
  });

  it("session ready with a completed turn is a completion", () => {
    const done = {
      ...baseThread,
      session: session("ready"),
      latestTurn: turn("completed"),
    };
    const states = projectAwarenessStates({
      threads: [{ environmentId: EnvironmentId.make("env-1"), ...done }],
      projectTitleByKey: titles,
    });
    expect(states[0]?.phase).toBe("completed");
  });

  it("falls back to the thread title alone when the project is unknown", () => {
    const states = projectAwarenessStates({
      threads: [
        {
          environmentId: EnvironmentId.make("env-1"),
          ...baseThread,
          projectId: "unknown",
          session: session("ready"),
        },
      ],
      projectTitleByKey: titles,
    });
    expect(states[0]?.projectTitle).toBe("");
  });
});

describe("delivery-independent phase recording", () => {
  it("never replays a candidate dropped by main while focused", () => {
    const states = [makeState({ threadId: "t1", phase: "completed" })];
    const focused = reconcileAwarenessNotifications({
      previousPhases: new Map([["env-1:t1", "running"]]),
      states,
      preferences: allOn,
    });
    expect(focused.notifications).toHaveLength(1);
    // Main drops this candidate while focused. The next snapshot still uses the new map.
    const blurred = reconcileAwarenessNotifications({
      previousPhases: focused.nextPhases,
      states,
      preferences: allOn,
    });
    expect(blurred.notifications).toEqual([]);
  });

  it("gates every phase independently and records disabled transitions", () => {
    const phases = ["waiting_for_approval", "waiting_for_input", "completed", "failed"] as const;
    const keys = [
      "notifyOnApproval",
      "notifyOnInput",
      "notifyOnCompletion",
      "notifyOnFailure",
    ] as const;
    for (const [index, key] of keys.entries()) {
      for (const [phaseIndex, phase] of phases.entries()) {
        const result = reconcileAwarenessNotifications({
          previousPhases: new Map([["env-1:t1", "running"]]),
          states: [makeState({ threadId: "t1", phase })],
          preferences: { ...allOn, [key]: false },
        });
        expect(result.notifications).toHaveLength(index === phaseIndex ? 0 : 1);
        expect(result.nextPhases.get("env-1:t1")).toBe(phase);
      }
    }
  });

  it("re-primes a thread after it disappears", () => {
    const absent = reconcileAwarenessNotifications({
      previousPhases: new Map([["env-1:t1", "running"]]),
      states: [],
      preferences: allOn,
    });
    const reappeared = reconcileAwarenessNotifications({
      previousPhases: absent.nextPhases,
      states: [makeState({ threadId: "t1", phase: "completed" })],
      preferences: allOn,
    });
    expect(reappeared.notifications).toEqual([]);
  });

  it("keeps matching thread IDs in different environments independent", () => {
    const result = reconcileAwarenessNotifications({
      previousPhases: new Map([
        ["env-1:t1", "running"],
        ["env-2:t1", "completed"],
      ]),
      states: [
        makeState({ threadId: "t1", phase: "completed" }),
        makeState({
          environmentId: EnvironmentId.make("env-2"),
          threadId: "t1",
          phase: "completed",
        }),
      ],
      preferences: allOn,
    });
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.environmentId).toBe("env-1");
  });
});
