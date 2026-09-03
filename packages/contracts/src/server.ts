import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ExecutionEnvironmentDescriptor, ServerSelfUpdateMethod } from "./environment.ts";
import { ServerAuthDescriptor } from "./auth.ts";
import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  KeybindingCommand,
  KeybindingValue,
  KeybindingWhen,
  ResolvedKeybindingsConfig,
} from "./keybindings.ts";
import { EditorId, FileManagerRevealKind, RemoteOpenTarget } from "./editor.ts";
import { ModelCapabilities } from "./model.ts";
import { RuntimeMode } from "./orchestration.ts";
import { ProviderFeatureCapabilities } from "./providerCapabilities.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerSettings } from "./settings.ts";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

// Issue kinds grow over time; older clients must not fail the whole config
// decode over a kind they cannot render.
const ServerConfigIssues = ForwardCompatibleArray(ServerConfigIssue);

export const ServerProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type ServerProviderState = typeof ServerProviderState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
  /**
   * The provider's own account identity when one is readable — Codex's
   * ChatGPT account id. Opaque; it exists so a client can tell whether two
   * sign-ins share a subscription, such as a configured Codex instance and
   * the Codex backend an agent brings its own credentials for.
   */
  accountId: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderAuth = typeof ServerProviderAuth.Type;

export const ServerProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  aliases: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  badge: Schema.optional(Schema.Literal("new")),
  isCustom: Schema.Boolean,
  isDefault: Schema.optional(Schema.Boolean),
  isLegacy: Schema.optional(Schema.Boolean),
  capabilities: Schema.NullOr(ModelCapabilities),
  /** Optional controls used only by background text generation pickers. */
  backgroundTextGenerationCapabilities: Schema.optional(Schema.NullOr(ModelCapabilities)),
});
export type ServerProviderModel = typeof ServerProviderModel.Type;

export const ServerProviderSlashCommandInput = Schema.Struct({
  hint: TrimmedNonEmptyString,
});
export type ServerProviderSlashCommandInput = typeof ServerProviderSlashCommandInput.Type;

export const ServerProviderSlashCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(ServerProviderSlashCommandInput),
});
export type ServerProviderSlashCommand = typeof ServerProviderSlashCommand.Type;

export const ServerProviderSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  scope: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  displayName: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
  /**
   * The skill is hidden from the agent's own skill tool, so only the user can
   * start it — Claude Code's `disable-model-invocation`. Composers must offer
   * it as a slash command; naming it in prose does nothing.
   */
  userInvocationOnly: Schema.optional(Schema.Boolean),
  /**
   * The mirror of {@link ServerProviderSkill.userInvocationOnly}: Claude Code's
   * `user-invocable: false` keeps the skill out of its own slash commands, so
   * only the agent can start it. Composers must not offer it under `/`.
   */
  userInvocable: Schema.optional(Schema.Boolean),
});
export type ServerProviderSkill = typeof ServerProviderSkill.Type;

const ServerProviderUsagePercent = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(100),
);

export const ServerProviderUsageWindow = Schema.Struct({
  label: TrimmedNonEmptyString,
  usedPercent: ServerProviderUsagePercent,
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

export const ServerProviderUsageLimits = Schema.Struct({
  /**
   * Where the reading came from (`codexAppServer`, `claudeOAuth`,
   * `claudePrint`, …). Provenance only — nothing renders it.
   *
   * An open string rather than a closed union: a provider gaining a new usage
   * source must not fail an older client's snapshot decode. `ServerProviders`
   * drops members it cannot decode, so a closed union here would make the
   * whole provider vanish from the picker over a field no one reads.
   */
  source: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  windows: Schema.Array(ServerProviderUsageWindow),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

/**
 * A backend an agent provider brings its own sign-in for.
 *
 * Prime Agent runs models on Anthropic or OpenAI Codex with credentials of its
 * own rather than through a configured Pylon instance. Each entry records what
 * the server could read about that sign-in: an account identity to match
 * against a configured instance's `auth.accountId`, and a capacity reading
 * taken with the backend's own credential when it was fresh enough to ask.
 * Either may be absent; clients say "verified" only when one of them is not.
 *
 * `backend` is the agent's own name for the backend (`anthropic`,
 * `openai-codex`), an open string for the same reason `usageLimits.source` is.
 */
export const ServerProviderBackend = Schema.Struct({
  backend: TrimmedNonEmptyString,
  accountId: Schema.optional(TrimmedNonEmptyString),
  usageLimits: Schema.optional(ServerProviderUsageLimits),
});
export type ServerProviderBackend = typeof ServerProviderBackend.Type;

/**
 * Availability of a configured provider instance from the runtime's POV.
 *
 *  - `available` — this build and its current host/runtime can materialize
 *    the configured driver instance. Default for legacy snapshots produced
 *    from the closed `ServerSettings.providers` map.
 *  - `unavailable` — the configured driver instance cannot materialize in
 *    this build or on the current host/runtime. This includes drivers absent
 *    after a rollback as well as shipped drivers that reject the host platform
 *    or another runtime prerequisite. The snapshot is preserved so clients
 *    can show the supplied remediation without silently changing the stored
 *    provider choice, and so configuration round-trips when it is usable again.
 *
 * Snapshots with `availability: "unavailable"` MUST set
 * `installed: false` and `enabled: false`; the runtime refuses turn
 * starts against them with a structured error.
 */
export const ServerProviderAvailability = Schema.Literals(["available", "unavailable"]);
export type ServerProviderAvailability = typeof ServerProviderAvailability.Type;

export const ServerProviderContinuation = Schema.Struct({
  groupKey: TrimmedNonEmptyString,
});
export type ServerProviderContinuation = typeof ServerProviderContinuation.Type;

export const ServerProviderVersionAdvisoryStatus = Schema.Literals([
  "unknown",
  "current",
  "behind_latest",
]);
export type ServerProviderVersionAdvisoryStatus = typeof ServerProviderVersionAdvisoryStatus.Type;

export const ServerProviderVersionAdvisory = Schema.Struct({
  status: ServerProviderVersionAdvisoryStatus,
  currentVersion: Schema.NullOr(TrimmedNonEmptyString),
  latestVersion: Schema.NullOr(TrimmedNonEmptyString),
  updateCommand: Schema.NullOr(TrimmedNonEmptyString),
  canUpdate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  checkedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderVersionAdvisory = typeof ServerProviderVersionAdvisory.Type;

export const ServerProviderDistributionClassification = Schema.Literals([
  "stock-or-custom",
  "pylon-unmanaged",
  "pylon-managed",
  "invalid-receipt",
]);
export type ServerProviderDistributionClassification =
  typeof ServerProviderDistributionClassification.Type;

export const ServerProviderDistributionChannel = Schema.Literals(["preview", "stable"]);
export type ServerProviderDistributionChannel = typeof ServerProviderDistributionChannel.Type;

export const ServerPrimeManagedAction = Schema.Literals([
  "install",
  "update",
  "rollback",
  "use-stock",
  "cleanup",
]);
export type ServerPrimeManagedAction = typeof ServerPrimeManagedAction.Type;

export const ServerPrimeManagedOperationStatus = Schema.Literals([
  "queued",
  "downloading",
  "verifying",
  "installing",
  "waiting-for-quiescence",
  "switching",
  "succeeded",
  "failed",
]);
export type ServerPrimeManagedOperationStatus = typeof ServerPrimeManagedOperationStatus.Type;

export const ServerPrimeManagedCommandReceipt = Schema.Struct({
  commandId: TrimmedNonEmptyString,
  instanceId: ProviderInstanceId,
  action: ServerPrimeManagedAction,
  status: ServerPrimeManagedOperationStatus,
  channel: Schema.NullOr(ServerProviderDistributionChannel),
  buildId: Schema.NullOr(TrimmedNonEmptyString),
  message: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type ServerPrimeManagedCommandReceipt = typeof ServerPrimeManagedCommandReceipt.Type;

export const ServerPrimeManagedInstalledBuild = Schema.Struct({
  buildId: TrimmedNonEmptyString,
  channel: ServerProviderDistributionChannel,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ServerPrimeManagedInstalledBuild = typeof ServerPrimeManagedInstalledBuild.Type;

export const ServerPrimeManagedMaintenance = Schema.Struct({
  supported: Schema.Boolean,
  controlsAvailable: Schema.Boolean,
  mode: Schema.Literals(["stock", "managed"]),
  selectedBuildId: Schema.NullOr(TrimmedNonEmptyString),
  channel: Schema.NullOr(ServerProviderDistributionChannel),
  availableBuilds: Schema.Array(ServerPrimeManagedInstalledBuild),
  scheduled: Schema.NullOr(ServerPrimeManagedCommandReceipt),
  operation: Schema.NullOr(ServerPrimeManagedCommandReceipt),
  message: TrimmedNonEmptyString,
  guidance: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerPrimeManagedMaintenance = typeof ServerPrimeManagedMaintenance.Type;

export const ServerPrimeManagedCommandInput = Schema.Struct({
  commandId: TrimmedNonEmptyString,
  instanceId: ProviderInstanceId,
  action: ServerPrimeManagedAction,
  channel: Schema.optional(ServerProviderDistributionChannel),
  allowPreview: Schema.optional(Schema.Boolean),
  buildId: Schema.optional(TrimmedNonEmptyString),
  scheduleIfBusy: Schema.optional(Schema.Boolean),
});
export type ServerPrimeManagedCommandInput = typeof ServerPrimeManagedCommandInput.Type;

export class ServerPrimeManagedMaintenanceError extends Schema.TaggedErrorClass<ServerPrimeManagedMaintenanceError>()(
  "ServerPrimeManagedMaintenanceError",
  {
    instanceId: ProviderInstanceId,
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * Signed build identity for provider distributions that publish one.
 *
 * This stays separate from runtime capabilities and package versions. A provider can remain ready
 * while distribution proof or its advisory feed is unavailable.
 */
export const ServerProviderDistribution = Schema.Struct({
  classification: ServerProviderDistributionClassification,
  channel: Schema.NullOr(ServerProviderDistributionChannel),
  buildId: Schema.NullOr(TrimmedNonEmptyString),
  sequence: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  latestBuildId: Schema.NullOr(TrimmedNonEmptyString),
  latestSequence: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  updateAvailable: Schema.Boolean,
  checkedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderDistribution = typeof ServerProviderDistribution.Type;

export const ServerProviderUpdateStatus = Schema.Literals([
  "idle",
  "queued",
  "running",
  "succeeded",
  "failed",
  "unchanged",
]);
export type ServerProviderUpdateStatus = typeof ServerProviderUpdateStatus.Type;

export const ServerProviderUpdateState = Schema.Struct({
  status: ServerProviderUpdateStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
  output: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
});
export type ServerProviderUpdateState = typeof ServerProviderUpdateState.Type;

/**
 * Subscription rate-limit state as last reported by a running session.
 *
 * Distinct from `usageLimits`, which is a polled gauge: this is the pushed
 * signal a provider emits mid-session (`account.rate-limits.updated`), and it
 * is what tells the server an account is actually spent. `rejected` means the
 * provider refused the turn for quota reasons, not that a request failed.
 *
 * Volatile like `updateState` — never persisted. A restart re-learns it from
 * the next turn, and `resetsAt` bounds how long a stale value can matter.
 *
 * `rateLimitType` is an open string rather than a closed union: providers add
 * window kinds (`five_hour`, `seven_day`, `seven_day_opus`, …) on their own
 * schedule, and an unrecognized one must not fail the snapshot decode.
 */
export const ServerProviderRateLimitStatus = Schema.Literals([
  "allowed",
  "allowed_warning",
  "rejected",
]);
export type ServerProviderRateLimitStatus = typeof ServerProviderRateLimitStatus.Type;

export const ServerProviderRateLimit = Schema.Struct({
  status: ServerProviderRateLimitStatus,
  rateLimitType: Schema.optional(TrimmedNonEmptyString),
  resetsAt: Schema.optional(IsoDateTime),
  observedAt: IsoDateTime,
});
export type ServerProviderRateLimit = typeof ServerProviderRateLimit.Type;

export const ServerProvider = Schema.Struct({
  // Routing key for the configured instance this snapshot represents. This
  // is the only stable identity consumers may use for provider routing.
  instanceId: ProviderInstanceId,
  // Open driver kind slug that selects the implementation handling this
  // instance. It is metadata/capability context, not a routing key.
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  badgeLabel: Schema.optional(TrimmedNonEmptyString),
  continuation: Schema.optional(ServerProviderContinuation),
  // Versioned provider-neutral feature inventory. Optional so snapshots from
  // legacy producers retain their exact behavior through compatibility helpers.
  featureCapabilities: Schema.optionalKey(ProviderFeatureCapabilities),
  showInteractionModeToggle: Schema.optional(Schema.Boolean),
  requiresNewThreadForModelChange: Schema.optional(Schema.Boolean),
  supportedRuntimeModes: Schema.optional(Schema.Array(RuntimeMode)),
  supportsBackgroundTextGeneration: Schema.optional(Schema.Boolean),
  supportsConversationRollback: Schema.optional(Schema.Boolean),
  /**
   * Whether this exact driver/runtime may have more than one enabled instance.
   * Missing is fail-closed: older or unknown drivers must not be duplicated until
   * the host server publishes an explicit current capability.
   */
  supportsMultipleInstances: Schema.optional(Schema.Boolean),
  /** Actionable host/driver reason when multiple enabled instances are unavailable. */
  multipleInstancesUnavailableReason: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  // Optional for back-compat: every legacy producer omits this field and
  // an absent value is interpreted as `"available"` by consumers (see
  // `isProviderAvailable`). New `ProviderInstanceRegistry` outputs set it
  // explicitly so clients can render unavailable shadows from configured
  // instances that this build or host/runtime cannot materialize.
  availability: Schema.optional(ServerProviderAvailability),
  // Human-readable reason populated when `availability === "unavailable"`.
  // Surfaces in clients alongside the unavailable-provider affordance.
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
  slashCommands: Schema.Array(ServerProviderSlashCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  skills: Schema.Array(ServerProviderSkill).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  usageLimits: Schema.optional(ServerProviderUsageLimits),
  backends: Schema.optional(Schema.Array(ServerProviderBackend)),
  rateLimit: Schema.optional(ServerProviderRateLimit),
  versionAdvisory: Schema.optionalKey(ServerProviderVersionAdvisory),
  distribution: Schema.optionalKey(ServerProviderDistribution),
  updateState: Schema.optionalKey(ServerProviderUpdateState),
});
export type ServerProvider = typeof ServerProvider.Type;

// Provider status kinds grow over time (ServerProviderState,
// ServerProviderAuthStatus, ServerProviderVersionAdvisoryStatus,
// ServerProviderUpdateStatus); an older client must not fail the whole config
// decode over one provider it cannot render.
export const ServerProviders = ForwardCompatibleArray(ServerProvider);
export type ServerProviders = typeof ServerProviders.Type;

/**
 * Treat the optional `availability` as "available" when absent. This is
 * the rule legacy producers (which omit the field) and new producers
 * (which set it explicitly) agree on so consumers never have to thread
 * `?? "available"` defaults through their code paths.
 */
export const isProviderAvailable = (snapshot: ServerProvider): boolean =>
  snapshot.availability !== "unavailable";

export const DEFAULT_SERVER_PROVIDER_RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

type ServerProviderExecutionPolicySnapshot = Pick<
  ServerProvider,
  "featureCapabilities" | "supportedRuntimeModes"
>;

type ServerProviderBackgroundTextGenerationSnapshot = Pick<
  ServerProvider,
  "featureCapabilities" | "supportsBackgroundTextGeneration"
>;

type ServerProviderConversationRollbackSnapshot = Pick<
  ServerProvider,
  "featureCapabilities" | "supportsConversationRollback"
>;

export const getServerProviderSupportedRuntimeModes = (
  snapshot: ServerProviderExecutionPolicySnapshot | null | undefined,
): ReadonlyArray<RuntimeMode> =>
  snapshot?.featureCapabilities?.executionPolicy?.runtimeModes ??
  snapshot?.supportedRuntimeModes ??
  DEFAULT_SERVER_PROVIDER_RUNTIME_MODES;

export const resolveServerProviderRuntimeMode = (
  snapshot: ServerProviderExecutionPolicySnapshot | null | undefined,
  runtimeMode: RuntimeMode,
): RuntimeMode => {
  const supported = getServerProviderSupportedRuntimeModes(snapshot);
  return supported.includes(runtimeMode) ? runtimeMode : (supported[0] ?? runtimeMode);
};

export const supportsServerProviderBackgroundTextGeneration = (
  snapshot: ServerProviderBackgroundTextGenerationSnapshot | null | undefined,
): boolean => {
  const automation = snapshot?.featureCapabilities?.automation;
  if (automation !== undefined) {
    return (
      automation.support === "read-write" &&
      automation.operations.includes("background-text-generation")
    );
  }
  return snapshot?.supportsBackgroundTextGeneration !== false;
};

export const supportsServerProviderConversationRollback = (
  snapshot: ServerProviderConversationRollbackSnapshot | null | undefined,
): boolean => {
  if (snapshot?.supportsConversationRollback !== true) {
    return false;
  }
  const history = snapshot.featureCapabilities?.history;
  if (history !== undefined) {
    return history.support === "read-write" && history.operations.includes("rollback");
  }
  return true;
};

export const ServerObservability = Schema.Struct({
  logsDirectoryPath: TrimmedNonEmptyString,
  localTracingEnabled: Schema.Boolean,
  otlpTracesUrl: Schema.optional(TrimmedNonEmptyString),
  otlpTracesEnabled: Schema.Boolean,
  otlpMetricsUrl: Schema.optional(TrimmedNonEmptyString),
  otlpMetricsEnabled: Schema.Boolean,
});
export type ServerObservability = typeof ServerObservability.Type;

export const ServerTraceDiagnosticsErrorKind = Schema.Literals([
  "trace-file-not-found",
  "trace-file-read-failed",
]);
export type ServerTraceDiagnosticsErrorKind = typeof ServerTraceDiagnosticsErrorKind.Type;

export const ServerTraceDiagnosticsSpanSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  count: NonNegativeInt,
  failureCount: NonNegativeInt,
  totalDurationMs: Schema.Number,
  averageDurationMs: Schema.Number,
  maxDurationMs: Schema.Number,
});
export type ServerTraceDiagnosticsSpanSummary = typeof ServerTraceDiagnosticsSpanSummary.Type;

export const ServerTraceDiagnosticsFailureSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  cause: TrimmedNonEmptyString,
  count: NonNegativeInt,
  lastSeenAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsFailureSummary = typeof ServerTraceDiagnosticsFailureSummary.Type;

export const ServerTraceDiagnosticsRecentFailure = Schema.Struct({
  name: TrimmedNonEmptyString,
  cause: TrimmedNonEmptyString,
  durationMs: Schema.Number,
  endedAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsRecentFailure = typeof ServerTraceDiagnosticsRecentFailure.Type;

export const ServerTraceDiagnosticsSpanOccurrence = Schema.Struct({
  name: TrimmedNonEmptyString,
  durationMs: Schema.Number,
  endedAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsSpanOccurrence = typeof ServerTraceDiagnosticsSpanOccurrence.Type;

export const ServerTraceDiagnosticsLogEvent = Schema.Struct({
  spanName: TrimmedNonEmptyString,
  level: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  seenAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsLogEvent = typeof ServerTraceDiagnosticsLogEvent.Type;

export const ServerTraceDiagnosticsResult = Schema.Struct({
  traceFilePath: TrimmedNonEmptyString,
  scannedFilePaths: Schema.Array(TrimmedNonEmptyString),
  readAt: Schema.DateTimeUtc,
  recordCount: NonNegativeInt,
  parseErrorCount: NonNegativeInt,
  firstSpanAt: Schema.Option(Schema.DateTimeUtc),
  lastSpanAt: Schema.Option(Schema.DateTimeUtc),
  failureCount: NonNegativeInt,
  interruptionCount: NonNegativeInt,
  slowSpanThresholdMs: NonNegativeInt,
  slowSpanCount: NonNegativeInt,
  logLevelCounts: Schema.Record(TrimmedNonEmptyString, NonNegativeInt),
  topSpansByCount: Schema.Array(ServerTraceDiagnosticsSpanSummary),
  slowestSpans: Schema.Array(ServerTraceDiagnosticsSpanOccurrence),
  commonFailures: Schema.Array(ServerTraceDiagnosticsFailureSummary),
  latestFailures: Schema.Array(ServerTraceDiagnosticsRecentFailure),
  latestWarningAndErrorLogs: Schema.Array(ServerTraceDiagnosticsLogEvent),
  partialFailure: Schema.Option(Schema.Boolean),
  error: Schema.Option(
    Schema.Struct({
      kind: ServerTraceDiagnosticsErrorKind,
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerTraceDiagnosticsResult = typeof ServerTraceDiagnosticsResult.Type;

export const ServerProcessSignal = Schema.Literals(["SIGINT", "SIGKILL"]);
export type ServerProcessSignal = typeof ServerProcessSignal.Type;

export const ServerProcessDiagnosticsEntry = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: NonNegativeInt,
  ppid: NonNegativeInt,
  pgid: Schema.Option(Schema.Int),
  status: TrimmedNonEmptyString,
  cpuPercent: Schema.Number,
  rssBytes: NonNegativeInt,
  elapsed: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  childPids: Schema.Array(PositiveInt),
});
export type ServerProcessDiagnosticsEntry = typeof ServerProcessDiagnosticsEntry.Type;

export const ServerProcessDiagnosticsResult = Schema.Struct({
  serverPid: PositiveInt,
  readAt: Schema.DateTimeUtc,
  processCount: NonNegativeInt,
  totalRssBytes: NonNegativeInt,
  totalCpuPercent: Schema.Number,
  processes: Schema.Array(ServerProcessDiagnosticsEntry),
  error: Schema.Option(
    Schema.Struct({
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerProcessDiagnosticsResult = typeof ServerProcessDiagnosticsResult.Type;

export const ServerProcessResourceHistoryInput = Schema.Struct({
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
});
export type ServerProcessResourceHistoryInput = typeof ServerProcessResourceHistoryInput.Type;

export const ServerProcessResourceHistoryBucket = Schema.Struct({
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.DateTimeUtc,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  maxRssBytes: NonNegativeInt,
  maxProcessCount: NonNegativeInt,
});
export type ServerProcessResourceHistoryBucket = typeof ServerProcessResourceHistoryBucket.Type;

export const ServerProcessResourceHistorySummary = Schema.Struct({
  processKey: TrimmedNonEmptyString,
  pid: PositiveInt,
  ppid: NonNegativeInt,
  command: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  isServerRoot: Schema.Boolean,
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
  currentCpuPercent: Schema.Number,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  cpuSecondsApprox: Schema.Number,
  currentRssBytes: NonNegativeInt,
  maxRssBytes: NonNegativeInt,
  sampleCount: NonNegativeInt,
});
export type ServerProcessResourceHistorySummary = typeof ServerProcessResourceHistorySummary.Type;

export const ServerProcessResourceHistoryFailureTag = Schema.Literals([
  "ProcessDiagnosticsQueryTimeoutError",
  "ProcessDiagnosticsQueryFailedError",
  "ProcessDiagnosticsServerProcessSignalError",
  "ProcessDiagnosticsNotDescendantError",
  "ProcessDiagnosticsSignalFailedError",
]);
export type ServerProcessResourceHistoryFailureTag =
  typeof ServerProcessResourceHistoryFailureTag.Type;

export const ServerProcessResourceHistoryResult = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
  sampleIntervalMs: NonNegativeInt,
  retainedSampleCount: NonNegativeInt,
  totalCpuSecondsApprox: Schema.Number,
  buckets: Schema.Array(ServerProcessResourceHistoryBucket),
  topProcesses: Schema.Array(ServerProcessResourceHistorySummary),
  error: Schema.Option(
    Schema.Struct({
      failureTag: ServerProcessResourceHistoryFailureTag,
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerProcessResourceHistoryResult = typeof ServerProcessResourceHistoryResult.Type;

export const ServerSignalProcessInput = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: NonNegativeInt,
  signal: ServerProcessSignal,
});
export type ServerSignalProcessInput = typeof ServerSignalProcessInput.Type;

export const ServerSignalProcessResult = Schema.Struct({
  pid: PositiveInt,
  signal: ServerProcessSignal,
  signaled: Schema.Boolean,
  message: Schema.Option(TrimmedNonEmptyString),
});
export type ServerSignalProcessResult = typeof ServerSignalProcessResult.Type;

/**
 * A palette the environment's machine publishes for Pylon to follow, read
 * from a theme file next to the rest of the environment's state. Two seed
 * colors rather than a full palette: clients derive the remaining roles with
 * the same generator the guided theme editor uses, so a desktop theme carries
 * over as a coherent Pylon palette instead of a foreign one.
 */
export const EnvironmentThemeColor = Schema.String.check(
  Schema.isPattern(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
);
export type EnvironmentThemeColor = typeof EnvironmentThemeColor.Type;

/**
 * Matches the client-side theme id rule, so a published id is selectable.
 * The appearance keywords are excluded outright: a published `dark.json`
 * would otherwise capture every client whose stored preference is the stock
 * `"dark"`, retinting people who never chose it.
 */
export const EnvironmentThemeId = Schema.String.check(
  Schema.isPattern(/^(?!(?:system|light|dark)$)[a-z0-9](?:[a-z0-9-]{0,47})$/),
);
export type EnvironmentThemeId = typeof EnvironmentThemeId.Type;

/**
 * Role colors as published. Values are any CSS color the client's theme
 * parser accepts (exported theme files use oklch), canonicalized client-side;
 * roles a build does not know are dropped there, so a machine may publish
 * roles a newer client added without breaking an older one. Keys must still
 * be role-shaped and values color-sized, so the record stays open to future
 * vocabulary without being an arbitrary-payload channel.
 */
const EnvironmentThemeColors = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/)),
  TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
);

const environmentThemeFields = {
  /**
   * Standard exported theme files (the Download button's output) carry the
   * exporting build's theme-file version; the seeded short form a desktop
   * generates has no version. Pylon exports `2` and still reads `1`, and the
   * client drops roles it does not know, so both load without a translation
   * step here.
   */
  version: Schema.optional(Schema.Literals([1, 2])),
  /** Shown on the theme card, e.g. the desktop theme's own name. */
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(48)),
  appearance: Schema.Literals(["light", "dark"]),
  /**
   * Seed colors. When present, clients derive the full palette from them with
   * the guided theme editor's generator and layer `colors` on top; when
   * absent, `colors` is the palette, as in an exported theme file.
   */
  canvas: Schema.optional(EnvironmentThemeColor),
  accent: Schema.optional(EnvironmentThemeColor),
  colors: Schema.optional(EnvironmentThemeColors),
  /** The other appearance's palette, as exported theme files carry it. */
  variants: Schema.optional(
    Schema.Struct({
      light: Schema.optional(EnvironmentThemeColors),
      dark: Schema.optional(EnvironmentThemeColors),
    }),
  ),
};

/** One published theme file. The id is the filename, not part of the content,
 * so a file cannot claim another file's identity; an embedded `id` is ignored. */
export const EnvironmentThemeFile = Schema.Struct(environmentThemeFields);
export type EnvironmentThemeFile = typeof EnvironmentThemeFile.Type;

export const EnvironmentTheme = Schema.Struct({
  /** The publishing filename without its extension, stable across recolors. */
  id: EnvironmentThemeId,
  ...environmentThemeFields,
});
export type EnvironmentTheme = typeof EnvironmentTheme.Type;

/**
 * Whether a theme file carries anything to render. A file with neither seeds
 * nor colors would show as the stock palette wearing a name, which reads as a
 * bug rather than a theme — the CLI and the server watcher both reject it,
 * through this one predicate so they cannot drift.
 */
export function environmentThemeFileHasColors(file: EnvironmentThemeFile): boolean {
  return (
    (file.canvas !== undefined && file.accent !== undefined) ||
    (file.colors !== undefined && Object.keys(file.colors).length > 0)
  );
}

export const ServerConfig = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  auth: ServerAuthDescriptor,
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  // Editor ids grow over time; drop ones this build does not know rather than
  // failing the whole config decode.
  availableEditors: ForwardCompatibleArray(EditorId),
  /**
   * SSH hosts this environment advertises for remote open-in-editor links.
   * Absent on servers that predate the feature; empty when the machine has no
   * sshd or no advertisable name.
   */
  remoteOpenTargets: Schema.optionalKey(ForwardCompatibleArray(RemoteOpenTarget)),
  observability: ServerObservability,
  settings: ServerSettings,
  /** Whether shell subscriptions can emit an opt-in catch-up completion marker. */
  shellResumeCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /** Whether shell.openInEditor honors `LaunchEditorInput.reveal` for the
      file-manager editor. */
  shellRevealInFileManager: Schema.optionalKey(Schema.Boolean),
  /** File-manager wording clients should use for reveal actions. */
  shellRevealInFileManagerKind: Schema.optionalKey(FileManagerRevealKind),
  /** Whether thread subscriptions can emit an opt-in catch-up completion marker. */
  threadResumeCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * Whether thread detail reads accept a turn window (`turnLimit`/
   * `beforeCursor`) and return `page` metadata. Clients must not send window
   * fields to servers that don't advertise this.
   */
  threadSnapshotPagination: Schema.optionalKey(Schema.Boolean),
  /**
   * Whether thread subscriptions accept an explicit opt-in for rollback-status
   * events. Clients must not request the new closed-union member from servers
   * that do not advertise this capability.
   */
  rollbackStatusStreaming: Schema.optionalKey(Schema.Boolean),
  /**
   * Palettes published by this environment's machine. Never sent in a config
   * snapshot: the theme stream emits the current set before any change, so a
   * snapshot carrying it too would hand every subscriber the same array twice
   * per connect. Clients populate this by projecting `environmentThemesUpdated`,
   * and it stays absent for subscribers that did not opt in.
   */
  environmentThemes: Schema.optional(Schema.Array(EnvironmentTheme)),
});
export type ServerConfig = typeof ServerConfig.Type;

const ServerUpsertKeybindingReplaceTarget = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
});

export const ServerUpsertKeybindingInput = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
  replace: Schema.optional(ServerUpsertKeybindingReplaceTarget),
});
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerRemoveKeybindingInput = ServerUpsertKeybindingReplaceTarget;
export type ServerRemoveKeybindingInput = typeof ServerRemoveKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerRemoveKeybindingResult = ServerUpsertKeybindingResult;
export type ServerRemoveKeybindingResult = typeof ServerRemoveKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviders,
  settings: Schema.optional(ServerSettings),
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerConfigKeybindingsUpdatedPayload = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerConfigKeybindingsUpdatedPayload =
  typeof ServerConfigKeybindingsUpdatedPayload.Type;

export const ServerConfigProviderStatusesPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerConfigProviderStatusesPayload = typeof ServerConfigProviderStatusesPayload.Type;

export const ServerConfigSettingsUpdatedPayload = Schema.Struct({
  settings: ServerSettings,
});
export type ServerConfigSettingsUpdatedPayload = typeof ServerConfigSettingsUpdatedPayload.Type;

export const ServerConfigStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  config: ServerConfig,
});
export type ServerConfigStreamSnapshotEvent = typeof ServerConfigStreamSnapshotEvent.Type;

export const ServerConfigStreamKeybindingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("keybindingsUpdated"),
  payload: ServerConfigKeybindingsUpdatedPayload,
});
export type ServerConfigStreamKeybindingsUpdatedEvent =
  typeof ServerConfigStreamKeybindingsUpdatedEvent.Type;

export const ServerConfigStreamProviderStatusesEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerStatuses"),
  payload: ServerConfigProviderStatusesPayload,
});
export type ServerConfigStreamProviderStatusesEvent =
  typeof ServerConfigStreamProviderStatusesEvent.Type;

export const ServerConfigStreamSettingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("settingsUpdated"),
  payload: ServerConfigSettingsUpdatedPayload,
});
export type ServerConfigStreamSettingsUpdatedEvent =
  typeof ServerConfigStreamSettingsUpdatedEvent.Type;

export const ServerConfigEnvironmentThemesUpdatedPayload = Schema.Struct({
  /** The full published set; empty once the machine publishes none. */
  themes: Schema.Array(EnvironmentTheme),
});
export type ServerConfigEnvironmentThemesUpdatedPayload =
  typeof ServerConfigEnvironmentThemesUpdatedPayload.Type;

export const ServerConfigStreamEnvironmentThemesUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("environmentThemesUpdated"),
  payload: ServerConfigEnvironmentThemesUpdatedPayload,
});
export type ServerConfigStreamEnvironmentThemesUpdatedEvent =
  typeof ServerConfigStreamEnvironmentThemesUpdatedEvent.Type;

export const ServerConfigStreamEvent = Schema.Union([
  ServerConfigStreamSnapshotEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderStatusesEvent,
  ServerConfigStreamSettingsUpdatedEvent,
  ServerConfigStreamEnvironmentThemesUpdatedEvent,
]);
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type;

/** Terminal selection recorded by the service launcher for one update. */
export const ServerSelfUpdateOutcome = Schema.Struct({
  id: TrimmedNonEmptyString,
  fromVersion: TrimmedNonEmptyString,
  targetVersion: TrimmedNonEmptyString,
  status: Schema.Literals(["committed", "rolled-back", "failed"]),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ServerSelfUpdateOutcome = typeof ServerSelfUpdateOutcome.Type;

export const ServerLifecycleReadyPayload = Schema.Struct({
  at: IsoDateTime,
  environment: ExecutionEnvironmentDescriptor,
  /** Present when this process resumed a launcher-managed update. */
  updateOutcome: Schema.optionalKey(ServerSelfUpdateOutcome),
});
export type ServerLifecycleReadyPayload = typeof ServerLifecycleReadyPayload.Type;

export const ServerLifecycleWelcomePayload = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;

export const ServerLifecycleStreamWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("welcome"),
  payload: ServerLifecycleWelcomePayload,
});
export type ServerLifecycleStreamWelcomeEvent = typeof ServerLifecycleStreamWelcomeEvent.Type;

export const ServerLifecycleStreamReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("ready"),
  payload: ServerLifecycleReadyPayload,
});
export type ServerLifecycleStreamReadyEvent = typeof ServerLifecycleStreamReadyEvent.Type;

export const ServerLifecycleStreamEvent = Schema.Union([
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleStreamReadyEvent,
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

export const ServerProviderUpdatedPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerProviderUpdatedPayload = typeof ServerProviderUpdatedPayload.Type;

export const ServerProviderUpdateInput = Schema.Struct({
  provider: ProviderDriverKind,
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ServerProviderUpdateInput = typeof ServerProviderUpdateInput.Type;

/**
 * Which sign-in an account uses.
 *
 * Not interchangeable: a Console (API-billing) account cannot sign in through
 * the subscription flow, and an org that mandates SSO cannot use either.
 * Guessing fails only after the user has already authenticated in a browser,
 * so the client asks.
 */
export const ServerProviderLoginMethod = Schema.Literals(["subscription", "console", "sso"]);
export type ServerProviderLoginMethod = typeof ServerProviderLoginMethod.Type;

export const ProviderLoginSessionId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProviderLoginSessionId"),
);
export type ProviderLoginSessionId = typeof ProviderLoginSessionId.Type;

export const ServerProviderLoginStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  method: ServerProviderLoginMethod,
  /** Pre-fills the login page so the account already signed in is not re-used. */
  email: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderLoginStartInput = typeof ServerProviderLoginStartInput.Type;

export const ServerProviderLoginStarted = Schema.Struct({
  sessionId: ProviderLoginSessionId,
  /** Authorization URL to open. The CLI also tries to open it itself. */
  url: TrimmedNonEmptyString,
});
export type ServerProviderLoginStarted = typeof ServerProviderLoginStarted.Type;

export const ServerProviderLoginSubmitInput = Schema.Struct({
  sessionId: ProviderLoginSessionId,
  code: TrimmedNonEmptyString,
});
export type ServerProviderLoginSubmitInput = typeof ServerProviderLoginSubmitInput.Type;

export const ServerProviderLoginCancelInput = Schema.Struct({
  sessionId: ProviderLoginSessionId,
});
export type ServerProviderLoginCancelInput = typeof ServerProviderLoginCancelInput.Type;

export const ServerProviderLoginResult = Schema.Struct({
  /**
   * Confirmed by re-reading auth status, not by the exit code. The CLI can exit
   * cleanly after the user abandons the browser.
   */
  signedIn: Schema.Boolean,
  email: Schema.optional(TrimmedNonEmptyString),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderLoginResult = typeof ServerProviderLoginResult.Type;

export class ServerProviderLoginError extends Schema.TaggedErrorClass<ServerProviderLoginError>()(
  "ServerProviderLoginError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider sign-in failed: ${this.reason}`;
  }
}

export class ServerProviderMutationBusyError extends Schema.TaggedErrorClass<ServerProviderMutationBusyError>()(
  "ServerProviderMutationBusyError",
  {
    reason: Schema.Literals(["rollback-active", "rollback-state-unavailable"]),
    providerInstanceIds: Schema.Array(ProviderInstanceId),
    threadIds: Schema.Array(ThreadId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "rollback-state-unavailable") {
      return "Provider settings are temporarily locked because rollback ownership could not be verified.";
    }
    return "Provider settings are temporarily locked while conversation rollback is active.";
  }
}

export class ServerProviderUpdateError extends Schema.TaggedErrorClass<ServerProviderUpdateError>()(
  "ServerProviderUpdateError",
  {
    provider: ProviderDriverKind,
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider update failed for ${this.provider}: ${this.reason}`;
  }
}

export const ServerSelfUpdateInput = Schema.Struct({
  /** Exact npm version of the `t3` package to install (never a dist-tag, so
      the server and the acknowledging client agree on what was requested). */
  targetVersion: TrimmedNonEmptyString,
});
export type ServerSelfUpdateInput = typeof ServerSelfUpdateInput.Type;

/** Acknowledgement that the update artifact is installed and the server is
    about to restart into it — the connection will drop moments later. */
export const ServerSelfUpdateResult = Schema.Struct({
  targetVersion: TrimmedNonEmptyString,
  method: ServerSelfUpdateMethod,
  /** Launcher-generated correlation ID. Absent when talking to older servers. */
  updateId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ServerSelfUpdateResult = typeof ServerSelfUpdateResult.Type;

export const ServerSelfUpdateProgressStage = Schema.Literals(["downloading", "installing"]);
export type ServerSelfUpdateProgressStage = typeof ServerSelfUpdateProgressStage.Type;

export const ServerSelfUpdateProgressEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    stage: ServerSelfUpdateProgressStage,
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    result: ServerSelfUpdateResult,
  }),
]);
export type ServerSelfUpdateProgressEvent = typeof ServerSelfUpdateProgressEvent.Type;

export class ServerSelfUpdateError extends Schema.TaggedErrorClass<ServerSelfUpdateError>()(
  "ServerSelfUpdateError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Server update failed: ${this.reason}`;
  }
}
