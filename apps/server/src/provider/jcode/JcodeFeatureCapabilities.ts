import {
  PROVIDER_FEATURE_CAPABILITIES_VERSION,
  type ProviderFeatureCapabilities,
} from "@t3tools/contracts";

const unavailable = (reason: string) => ({
  support: "unavailable" as const,
  reason,
  operations: [],
});

/**
 * Feature inventory for the Early Access Jcode provider.
 *
 * Jcode exposes a single full-access execution mode: SDK v1 has no way to gate
 * or narrow host tools per turn, so Pylon advertises `read-only` execution
 * policy with `enforcement: "none"` rather than implying a sandbox it cannot
 * deliver. Everything Pylon does not yet project carries an explicit reason so
 * clients can explain the gap without interpreting provider errors.
 *
 * Returns a fresh object per call; callers stamp it onto provider snapshots.
 */
export function makeJcodeFeatureCapabilities(): ProviderFeatureCapabilities {
  return {
    version: PROVIDER_FEATURE_CAPABILITIES_VERSION,
    authentication: unavailable(
      "Jcode inherits recognized host provider logins and does not expose Pylon-managed authentication controls.",
    ),
    executionPolicy: {
      support: "read-only",
      reason:
        "Jcode SDK v1 cannot gate or disable host tools per turn, so every session runs with full host access. This is not an operating-system sandbox.",
      operations: ["inspect"],
      runtimeModes: ["full-access"],
      enforcement: "none",
    },
    planning: unavailable("Jcode does not expose a Pylon-compatible plan mode."),
    goals: unavailable("Jcode does not project goal state into Pylon."),
    gates: unavailable("Jcode does not expose autonomous gate configuration."),
    agents: unavailable("Jcode does not expose native subagents to Pylon."),
    automation: unavailable("Jcode automations are not projected into Pylon."),
    resources: unavailable(
      "Jcode skills, prompts, packages, and MCP controls are not projected into Pylon.",
    ),
    inputQueue: unavailable("Jcode does not expose a compatible input queue to Pylon."),
    model: {
      support: "read-write",
      operations: ["select", "thinking"],
    },
    context: unavailable("Jcode compaction and context controls are not projected into Pylon."),
    history: unavailable(
      "Jcode history is not coordinated with Pylon filesystem checkpoints, so navigation and rollback stay unavailable.",
    ),
    reasoning: {
      support: "read-only",
      reason:
        "Pylon streams the reasoning Jcode emits for a turn and keeps the completed summary; Pylon cannot mutate it.",
      operations: ["final", "stream"],
    },
    usage: {
      support: "read-only",
      reason:
        "Jcode reports input, output, and cached input token counts per turn. It reports no cost estimate or rate-limit state.",
      operations: ["token-usage"],
    },
    sessionUi: unavailable("Jcode does not expose extension UI requests to Pylon."),
  };
}
