import {
  boundSessionGoalObjective,
  formatSessionGoalElapsed,
  formatSessionGoalStatus,
  formatSessionGoalTokenUsage,
  type SessionGoalSnapshot,
} from "@t3tools/client-runtime/state/session-goal";

export function buildSessionGoalMenuActions(snapshot: SessionGoalSnapshot) {
  const objective = snapshot.objective
    ? boundSessionGoalObjective(snapshot.objective)
    : snapshot.active
      ? "Objective unavailable"
      : "No active objective";
  const continuations = `${snapshot.continuationsUsed.toLocaleString("en-US")} ${
    snapshot.continuationsUsed === 1 ? "continuation" : "continuations"
  }`;

  return [
    {
      id: "session-goal:objective",
      title: objective,
      subtitle: "Objective · Read-only",
      image: "target",
      attributes: { disabled: true } as const,
    },
    {
      id: "session-goal:status",
      title: formatSessionGoalStatus(snapshot.status),
      subtitle: snapshot.active ? "Goal status · Active goal" : "Goal status",
      attributes: { disabled: true } as const,
    },
    {
      id: "session-goal:usage",
      title: formatSessionGoalTokenUsage(snapshot),
      subtitle: `${formatSessionGoalElapsed(snapshot.timeUsedSeconds)} elapsed · ${continuations}`,
      attributes: { disabled: true } as const,
    },
  ];
}
