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
  authentication: {
    support: "read-only" as const,
    reason:
      "Pylon reports whether Prime Agent has a configured model provider; sign-in and sign-out remain owned by the Prime Agent CLI.",
    operations: ["status"] as const,
  },
  planning: {
    support: "read-only" as const,
    reason:
      "Pylon shows bounded Prime plan progress from the managed daemon bridge or standard ACP PlanUpdated events. Prime does not expose a compatible formal Plan interaction mode.",
    operations: ["observe"] as const,
  },
  goals: unavailable("Goal state is not projected into Pylon yet."),
  gates: unavailable("Autonomous gate mutation is not exposed by the loaded Prime Agent runtime."),
  automation: {
    support: "read-write" as const,
    reason:
      "Pylon can run isolated background text generation through the selected Prime Agent installation without joining an interactive session.",
    operations: ["background-text-generation"] as const,
  },
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
  readonly inputQueueMutation: boolean;
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
      reasoning: unavailable(
        "Prime Agent ACP reasoning is not surfaced or retained by Pylon; private thought chunks are discarded at the adapter boundary.",
      ),
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
            "Pylon can run isolated background text generation and ask one bounded, ephemeral side question at a time in fresh approval-required daemon sessions.",
          operations: ["background-text-generation", "side-questions"],
        }
      : shared.automation,
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
        "Pylon shows bounded session-scoped skill and prompt metadata plus bounded commands, and can explicitly reload full-access sessions while idle; supervised reload, packages, and MCP controls are unavailable.",
      operations: ["skills", "prompts", "commands", "reload"],
    },
    inputQueue: input.inputQueue
      ? {
          support: "read-write",
          reason:
            input.inputQueueModes && input.inputQueueMutation
              ? "Pylon can observe privacy-safe queue counts, configure delivery, steer the active run, admit explicit follow-ups, clear pending inputs, and remove a sole lane item without interrupting current work."
              : input.inputQueueModes
                ? "Pylon can observe privacy-safe queue counts, configure delivery, steer the active run, admit explicit follow-ups, and clear pending inputs; per-lane removal is unavailable with the loaded daemon."
                : "Pylon can observe privacy-safe queue counts, steer the active run, admit explicit follow-ups, and clear pending inputs; delivery-mode and per-lane removal controls are unavailable with the loaded daemon.",
          operations: [
            "observe",
            "follow-up",
            "steer",
            "clear",
            ...(input.inputQueueMutation && input.inputQueueModes ? (["remove"] as const) : []),
            ...(input.inputQueueModes ? (["set-modes"] as const) : []),
          ],
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
          reason:
            "Pylon supports select, confirm, and input dialogs; editor replacement is cancelled until sensitive prefills have a non-durable transport.",
          operations: ["dialog", "notification", "status", "widget"],
        }
      : unavailable("Prime Agent extension UI responses are not wired into Pylon yet."),
  };
}
