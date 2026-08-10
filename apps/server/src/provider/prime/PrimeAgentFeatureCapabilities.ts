import {
  PROVIDER_FEATURE_CAPABILITIES_VERSION,
  type ProviderFeatureCapabilities,
} from "@t3tools/contracts";

const unavailable = (reason: string) => ({
  support: "unavailable" as const,
  reason,
  operations: [],
});

const shared = {
  version: PROVIDER_FEATURE_CAPABILITIES_VERSION,
  authentication: unavailable(
    "Prime Agent does not expose unified daemon authentication controls yet.",
  ),
  planning: unavailable("Prime Agent does not expose a Pylon-compatible plan mode."),
  goals: unavailable("Goal state is not projected into Pylon yet."),
  gates: unavailable("Autonomous gate mutation is not exposed by Prime Agent 0.7.1."),
  automation: unavailable("Prime Agent automations are not projected into Pylon yet."),
  resources: unavailable("Prime Agent resources are not projected into Pylon yet."),
  inputQueue: unavailable("Prime Agent input queues are not projected into Pylon yet."),
  context: unavailable("Prime Agent context controls are not projected into Pylon yet."),
  history: unavailable(
    "Prime Agent history is not coordinated with Pylon filesystem checkpoints yet.",
  ),
} as const;

export function makePrimeAgentFeatureCapabilities(input: {
  readonly runtime: "daemon" | "acp";
  readonly sessionUi: boolean;
  readonly inputQueue: boolean;
  readonly inputQueueModes: boolean;
  readonly agentCancel: boolean;
  readonly agentMessage: boolean;
  readonly agentLiveActivity?: boolean;
  readonly compaction: boolean;
  readonly refinement?: boolean;
  readonly autoCompaction: boolean;
  readonly goals: boolean;
  readonly sideQuestions: boolean;
}): ProviderFeatureCapabilities {
  if (input.runtime === "acp") {
    return {
      ...shared,
      executionPolicy: {
        support: "read-only",
        reason: "Prime Agent ACP sessions currently execute with full host access.",
        operations: ["inspect"],
        runtimeModes: ["full-access"],
        enforcement: "none",
      },
      agents: unavailable("Prime Agent ACP does not expose native subagents."),
      model: {
        support: "read-write",
        operations: ["select"],
      },
      reasoning: unavailable("Prime Agent ACP reasoning is not projected into Pylon yet."),
      usage: unavailable("Prime Agent ACP does not report normalized usage and cost."),
      sessionUi: unavailable("Prime Agent ACP does not expose extension UI requests."),
    };
  }

  return {
    ...shared,
    executionPolicy: {
      support: "read-write",
      reason:
        "Approval-required mode gates every Prime tool before execution, disables discovered extensions and subagent spawning, and is not an operating-system sandbox.",
      operations: ["inspect", "select"],
      runtimeModes: ["approval-required", "full-access"],
      enforcement: "host-gated",
    },
    agents: {
      support: "read-write",
      reason: input.agentLiveActivity
        ? "Pylon can show bounded, assistant-only live activity for active descendants in compatible full-access daemon sessions; supervised sessions and native history remain unavailable."
        : "Pylon can observe compatible Prime Agent descendants and configure bounded per-session spawn depth; live activity is unavailable with the loaded daemon and supervised sessions remain fixed at depth zero.",
      operations: [
        "observe",
        "hierarchy",
        ...(input.agentLiveActivity ? (["live-activity"] as const) : []),
        ...(input.agentMessage ? (["message"] as const) : []),
        ...(input.agentCancel ? (["cancel"] as const) : []),
        "set-depth",
      ],
    },
    automation: input.sideQuestions
      ? {
          support: "read-write",
          reason:
            "Pylon can ask one bounded, ephemeral side question at a time only in fresh approval-required daemon sessions; full-access, restored, and ACP sessions are unavailable.",
          operations: ["side-questions"],
        }
      : unavailable("The loaded Prime Agent daemon does not expose compatible side questions."),
    goals: input.goals
      ? {
          support: "read-only",
          reason:
            "Pylon can observe privacy-safe Prime Agent goal state in compatible full-access daemon sessions; goal mutation and supervised-session observation are unavailable.",
          operations: ["observe"],
        }
      : unavailable("The loaded Prime Agent runtime does not expose compatible goal state."),
    resources: {
      support: "read-write",
      reason:
        "Pylon shows safe session-scoped commands and can explicitly reload full-access sessions while idle; supervised reload, packages, and MCP controls are unavailable.",
      operations: ["commands", "reload"],
    },
    inputQueue: input.inputQueue
      ? {
          support: "read-write",
          reason: input.inputQueueModes
            ? "Pylon can observe privacy-safe queue counts, configure delivery, steer the active run, admit explicit follow-ups, and clear pending inputs without interrupting current work."
            : "Pylon can observe privacy-safe queue counts, steer the active run, admit explicit follow-ups, and clear pending inputs without interrupting current work; delivery-mode controls are unavailable with the loaded daemon.",
          operations: input.inputQueueModes
            ? ["observe", "follow-up", "steer", "clear", "set-modes"]
            : ["observe", "follow-up", "steer", "clear"],
        }
      : unavailable("The loaded Prime Agent daemon does not expose compatible input queue APIs."),
    context:
      input.compaction || input.refinement === true
        ? {
            support: "read-write",
            reason:
              "Pylon can request supported full-access context operations without retaining Prime's private instructions, summaries, paths, or native identifiers.",
            operations: [
              "observe",
              ...(input.compaction ? (["compact", "abort-compaction"] as const) : []),
              ...(input.autoCompaction ? (["configure-compaction"] as const) : []),
              ...(input.refinement === true ? (["refine"] as const) : []),
            ],
          }
        : {
            support: "read-only",
            reason:
              "Pylon shows Prime Agent compaction, retry, and refinement lifecycle without persisting native instructions or summaries; the loaded daemon does not expose compatible context controls.",
            operations: ["observe"],
          },
    model: {
      support: "read-write",
      operations: ["select", "thinking", "service-tier"],
    },
    reasoning: {
      support: "read-only",
      reason:
        "Pylon shows bounded final reasoning that the selected model explicitly exposes; live reasoning deltas are not persisted.",
      operations: ["final"],
    },
    usage: {
      support: "read-only",
      reason:
        "Pylon shows current context usage and the cost estimate Prime reports for each completed turn.",
      operations: ["token-usage", "cost"],
    },
    sessionUi: input.sessionUi
      ? {
          support: "read-write",
          operations: ["dialog", "notification", "status", "widget"],
        }
      : unavailable("Prime Agent extension UI responses are not wired into Pylon yet."),
  };
}
