import {
  boundSessionGoalObjective,
  formatSessionGoalElapsed,
  formatSessionGoalStatus,
  formatSessionGoalTokenUsage,
  type SessionGoalSnapshot,
} from "@t3tools/client-runtime/state/session-goal";

export function buildSessionGoalMenuActions(snapshot: SessionGoalSnapshot) {
  const hasGoal =
    snapshot.active || snapshot.status !== "idle" || Boolean(snapshot.objective?.trim());
  const objective = snapshot.objective
    ? boundSessionGoalObjective(snapshot.objective)
    : hasGoal
      ? "Objective unavailable"
      : "No persistent goal is active.";
  const continuations = `${snapshot.continuationsUsed.toLocaleString("en-US")} ${
    snapshot.continuationsUsed === 1 ? "continuation" : "continuations"
  }`;

  return [
    {
      id: "session-goal:objective",
      title: objective,
      subtitle: "Objective · Managed in chat",
      image: "target",
      attributes: { disabled: true } as const,
    },
    {
      id: "session-goal:status",
      title: formatSessionGoalStatus(snapshot.status),
      subtitle: snapshot.active ? "Goal status · Active goal" : "Goal status",
      attributes: { disabled: true } as const,
    },
    ...(hasGoal
      ? [
          {
            id: "session-goal:usage",
            title: formatSessionGoalTokenUsage(snapshot),
            subtitle: `${formatSessionGoalElapsed(snapshot.timeUsedSeconds)} elapsed · ${continuations}`,
            attributes: { disabled: true } as const,
          },
        ]
      : [
          {
            id: "session-goal:start-help",
            title: "Start a persistent goal to …",
            subtitle: "Ask the agent in chat",
            attributes: { disabled: true } as const,
          },
        ]),
  ];
}
