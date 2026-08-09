import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./orchestration.ts";

/**
 * Stable access vocabulary shared by provider feature groups.
 *
 * `read-only` means the provider can report the feature but Pylon cannot mutate
 * it. `read-write` means the provider accepts the advertised write operations.
 * Unsupported and temporarily unavailable features both use `unavailable`;
 * `reason` may explain why without making clients interpret provider errors.
 */
export const ProviderFeatureSupportLevel = Schema.Literals([
  "unavailable",
  "read-only",
  "read-write",
]);
export type ProviderFeatureSupportLevel = typeof ProviderFeatureSupportLevel.Type;

export const PROVIDER_FEATURE_CAPABILITIES_VERSION = 1;
export const PROVIDER_FEATURE_SUPPORT_REASON_MAX_CHARS = 500;

const ProviderFeatureSupportReason = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_FEATURE_SUPPORT_REASON_MAX_CHARS),
);

const providerFeatureSupportFields = {
  support: ProviderFeatureSupportLevel,
  reason: Schema.optional(ProviderFeatureSupportReason),
} as const;

export const ProviderFeatureSupport = Schema.Struct(providerFeatureSupportFields);
export type ProviderFeatureSupport = typeof ProviderFeatureSupport.Type;

/**
 * Operation arrays are forward-compatible: clients drop operation names added
 * by newer servers while retaining the feature group and operations they know.
 */
const AuthenticationOperations = ForwardCompatibleArray(
  Schema.Literals(["status", "login", "logout", "refresh", "accounts", "team-selection"]),
);
const ExecutionPolicyOperations = ForwardCompatibleArray(Schema.Literals(["inspect", "select"]));
const PlanningOperations = ForwardCompatibleArray(
  Schema.Literals(["observe", "propose", "update", "select-mode"]),
);
const GoalOperations = ForwardCompatibleArray(
  Schema.Literals(["observe", "create", "update", "pause", "resume", "complete", "clear"]),
);
const GateOperations = ForwardCompatibleArray(
  Schema.Literals(["observe", "configure", "run", "retry", "abort"]),
);
const AgentOperations = ForwardCompatibleArray(
  Schema.Literals([
    "observe",
    "hierarchy",
    "spawn",
    "message",
    "steer",
    "pause",
    "resume",
    "cancel",
    "stop",
    "delete",
    "set-depth",
  ]),
);
const AutomationOperations = ForwardCompatibleArray(
  Schema.Literals([
    "autonomous-runs",
    "heartbeats",
    "schedules",
    "side-questions",
    "background-text-generation",
  ]),
);
const ResourceOperations = ForwardCompatibleArray(
  Schema.Literals(["skills", "prompts", "extensions", "packages", "mcp", "commands", "reload"]),
);
const InputQueueOperations = ForwardCompatibleArray(
  Schema.Literals(["observe", "follow-up", "steer", "remove", "clear", "set-modes", "reorder"]),
);
const ModelOperations = ForwardCompatibleArray(
  Schema.Literals(["select", "thinking", "service-tier", "scoped-models", "transport", "cycle"]),
);
const ContextOperations = ForwardCompatibleArray(
  Schema.Literals([
    "observe",
    "compact",
    "abort-compaction",
    "configure-compaction",
    "refine",
    "auto-retry",
  ]),
);
const HistoryOperations = ForwardCompatibleArray(
  Schema.Literals([
    "navigate",
    "rollback",
    "fork",
    "clone",
    "switch",
    "import",
    "export",
    "labels",
  ]),
);
const ReasoningOperations = ForwardCompatibleArray(Schema.Literals(["final", "stream"]));
const UsageOperations = ForwardCompatibleArray(
  Schema.Literals(["token-usage", "cost", "rate-limits"]),
);
const SessionUiOperations = ForwardCompatibleArray(
  Schema.Literals(["dialog", "notification", "status", "widget"]),
);

export const ProviderAuthenticationCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: AuthenticationOperations,
});
export type ProviderAuthenticationCapability = typeof ProviderAuthenticationCapability.Type;

export const ProviderExecutionPolicyEnforcement = Schema.Literals([
  "none",
  "provider-native",
  "host-gated",
]);
export type ProviderExecutionPolicyEnforcement = typeof ProviderExecutionPolicyEnforcement.Type;

export const ProviderExecutionPolicyCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: ExecutionPolicyOperations,
  runtimeModes: Schema.Array(RuntimeMode),
  enforcement: Schema.optionalKey(ProviderExecutionPolicyEnforcement),
});
export type ProviderExecutionPolicyCapability = typeof ProviderExecutionPolicyCapability.Type;

export const ProviderPlanningCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: PlanningOperations,
});
export type ProviderPlanningCapability = typeof ProviderPlanningCapability.Type;

export const ProviderGoalCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: GoalOperations,
});
export type ProviderGoalCapability = typeof ProviderGoalCapability.Type;

export const ProviderGateCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: GateOperations,
});
export type ProviderGateCapability = typeof ProviderGateCapability.Type;

export const ProviderAgentCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: AgentOperations,
});
export type ProviderAgentCapability = typeof ProviderAgentCapability.Type;

export const ProviderAutomationCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: AutomationOperations,
});
export type ProviderAutomationCapability = typeof ProviderAutomationCapability.Type;

export const ProviderResourceCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: ResourceOperations,
});
export type ProviderResourceCapability = typeof ProviderResourceCapability.Type;

export const ProviderInputQueueCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: InputQueueOperations,
});
export type ProviderInputQueueCapability = typeof ProviderInputQueueCapability.Type;

export const ProviderModelCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: ModelOperations,
});
export type ProviderModelCapability = typeof ProviderModelCapability.Type;

export const ProviderContextCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: ContextOperations,
});
export type ProviderContextCapability = typeof ProviderContextCapability.Type;

export const ProviderHistoryCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: HistoryOperations,
});
export type ProviderHistoryCapability = typeof ProviderHistoryCapability.Type;

export const ProviderReasoningCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: ReasoningOperations,
});
export type ProviderReasoningCapability = typeof ProviderReasoningCapability.Type;

export const ProviderUsageCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: UsageOperations,
});
export type ProviderUsageCapability = typeof ProviderUsageCapability.Type;

export const ProviderSessionUiCapability = Schema.Struct({
  ...providerFeatureSupportFields,
  operations: SessionUiOperations,
});
export type ProviderSessionUiCapability = typeof ProviderSessionUiCapability.Type;

/**
 * Provider-neutral feature inventory attached to `ServerProvider` snapshots.
 *
 * The positive version allows capability semantics to evolve without coupling
 * them to the surrounding server-config version. Groups are optional so older
 * providers decode unchanged and newer groups can be adopted independently.
 * Unknown object fields are ignored by Effect Schema; unknown operation names
 * are dropped by the forward-compatible operation arrays above.
 */
export const ProviderFeatureCapabilities = Schema.Struct({
  version: PositiveInt,
  authentication: Schema.optionalKey(ProviderAuthenticationCapability),
  executionPolicy: Schema.optionalKey(ProviderExecutionPolicyCapability),
  planning: Schema.optionalKey(ProviderPlanningCapability),
  goals: Schema.optionalKey(ProviderGoalCapability),
  gates: Schema.optionalKey(ProviderGateCapability),
  agents: Schema.optionalKey(ProviderAgentCapability),
  automation: Schema.optionalKey(ProviderAutomationCapability),
  resources: Schema.optionalKey(ProviderResourceCapability),
  inputQueue: Schema.optionalKey(ProviderInputQueueCapability),
  model: Schema.optionalKey(ProviderModelCapability),
  context: Schema.optionalKey(ProviderContextCapability),
  history: Schema.optionalKey(ProviderHistoryCapability),
  reasoning: Schema.optionalKey(ProviderReasoningCapability),
  usage: Schema.optionalKey(ProviderUsageCapability),
  sessionUi: Schema.optionalKey(ProviderSessionUiCapability),
});
export type ProviderFeatureCapabilities = typeof ProviderFeatureCapabilities.Type;
