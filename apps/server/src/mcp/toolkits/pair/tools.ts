/**
 * Pair toolkit declaration: one lead thread and one persistent executor thread
 * that works in the lead's worktree. The executor's id is the delegated child
 * id for the reserved key `pair`, so no contract field or table records the
 * link. Starting a pair requires the `delegation` capability; driving an
 * existing pair accepts either the `pair` or `delegation` capability.
 *
 * @module mcp/toolkits/pair/tools
 */
import {
  McpCapabilityUnavailableError,
  ProviderInstanceId,
  RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MAX_PAIR_AWAIT_SECONDS } from "./logic.ts";

// Crypto reaches the handlers as a layer requirement of `toLayer(make)`.
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ProviderRegistry.ProviderRegistry,
  ServerSettings.ServerSettingsService,
  // Reads the lead's protected paths in the worktree the pair shares.
  FileSystem.FileSystem,
];

const MAX_BRIEF_CHARS = 32_000;
const MAX_PROTECTED_PATHS = 50;
const MIN_RESULT_CHARS = 1_000;
const MAX_RESULT_CHARS = 60_000;

export const PairExecutorState = Schema.Literals([
  "idle",
  "running",
  "completed",
  "interrupted",
  "error",
  "archived",
]);
export type PairExecutorState = typeof PairExecutorState.Type;

// ---- pair_start ----

export const PairStartInput = Schema.Struct({
  providerInstanceId: Schema.optional(
    ProviderInstanceId.annotate({
      description:
        "Provider instance for the executor, as listed in Pylon Settings → Providers. Omit unless the user named one: Pylon then uses the user's default delegation model.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Model slug or alias. Omit unless the user named a model.",
    }),
  ),
});
export type PairStartInput = typeof PairStartInput.Type;

export const PairStartResult = Schema.Struct({
  threadId: Schema.String,
  created: Schema.Boolean,
  state: PairExecutorState,
  providerInstanceId: Schema.String,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  /**
   * How to run the pair. A pair started mid-session reaches the lead here,
   * before its next session start carries the same text as instructions.
   */
  protocol: Schema.String,
});
export type PairStartResult = typeof PairStartResult.Type;

// ---- pair_handoff ----

export const PairHandoffInput = Schema.Struct({
  messageKey: TrimmedNonEmptyString.annotate({
    description:
      "Your own identifier for this brief: 1-64 letters, digits, underscores, or hyphens. Reusing it never sends the brief twice.",
  }),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_BRIEF_CHARS)).annotate({
    description:
      "The brief: exact files, the behavior wanted, the acceptance checks to run, exclusions, and the report format. The executor shares your worktree, so refer to paths directly.",
  }),
  protectedPaths: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(MAX_PROTECTED_PATHS)).annotate({
      description:
        "Files you own and the executor must not edit, normally your tests and contract, as paths relative to the worktree. Pylon records their content now and pair_await tells you if any changed. Each brief replaces the previous list; omit it to protect nothing.",
    }),
  ),
  steer: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Set true to redirect an executor that is already running. Allowed once per executor turn. Without it a running executor refuses the brief.",
    }),
  ),
});
export type PairHandoffInput = typeof PairHandoffInput.Type;

export const PairHandoffResult = Schema.Struct({
  threadId: Schema.String,
  accepted: Schema.Literal(true),
  messageId: Schema.String,
  steered: Schema.Boolean,
});
export type PairHandoffResult = typeof PairHandoffResult.Type;

// ---- pair_await ----

export const PairAwaitInput = Schema.Struct({
  maxSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_PAIR_AWAIT_SECONDS })).annotate({
      description:
        "Leave this out. The call waits as long as your provider's tool timeout allows and returns the moment the executor stops or needs the user, so a blocked call costs no tokens and a shorter wait gains nothing: any value above 0 is raised to that full wait. Pass 0 only to read the state without waiting. A third instant read in a row of a running executor waits the full time instead. If the executor is still running afterwards, end your turn: Pylon wakes you when it finishes or needs the user. Do not call this in a loop.",
    }),
  ),
  maxChars: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: MIN_RESULT_CHARS, maximum: MAX_RESULT_CHARS }),
    ).annotate({
      description: "Maximum characters of the executor's final message to return. Default 4000.",
    }),
  ),
});
export type PairAwaitInput = typeof PairAwaitInput.Type;

export const PairAwaitResult = Schema.Struct({
  threadId: Schema.String,
  state: PairExecutorState,
  waitedSeconds: Schema.Int,
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
  /** Present only once the executor is no longer running. */
  assistantMessage: Schema.NullOr(
    Schema.Struct({
      messageId: Schema.String,
      text: Schema.String,
      truncated: Schema.Boolean,
      createdAt: Schema.String,
    }),
  ),
  /** The files changed by the executor's latest turn, not by earlier briefs. */
  filesChanged: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.String,
      additions: Schema.Int,
      deletions: Schema.Int,
    }),
  ),
  /** Every turn the executor has completed for this pair. */
  turnCount: Schema.Int,
  /**
   * The protected paths of the latest brief, checked once the executor is no
   * longer running. Null while it runs, when the brief protected nothing, or
   * when the server restarted since the brief and the record was lost.
   */
  protectedPaths: Schema.NullOr(
    Schema.Struct({
      checked: Schema.Int,
      /** Paths whose content differs from the brief, or that no longer exist. */
      changed: Schema.Array(Schema.String),
    }),
  ),
});
export type PairAwaitResult = typeof PairAwaitResult.Type;

// ---- pair_stop ----

export const PairStopResult = Schema.Struct({
  threadId: Schema.String,
  interrupted: Schema.Boolean,
  state: PairExecutorState,
});
export type PairStopResult = typeof PairStopResult.Type;

// ---- Errors ----

export class PairLeadNotFoundError extends Schema.TaggedError<PairLeadNotFoundError>()(
  "PairLeadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return "This thread is no longer available.";
  }
}

export class PairDepthExceededError extends Schema.TaggedError<PairDepthExceededError>()(
  "PairDepthExceededError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return "An executor or delegated thread cannot start a pair. Report back to your lead instead.";
  }
}

export class PairLeadUnsupportedError extends Schema.TaggedError<PairLeadUnsupportedError>()(
  "PairLeadUnsupportedError",
  { providerInstanceId: Schema.String },
) {
  override get message(): string {
    return "This provider cannot lead a pair, because Pylon cannot hold its own subagents for one session. It works as the executor: ask the user to start the pair from a thread on another provider.";
  }
}

export class PairNotActiveError extends Schema.TaggedError<PairNotActiveError>()(
  "PairNotActiveError",
  {},
) {
  override get message(): string {
    return "This thread has no executor. Call pair_start first, or ask the user to turn on Pair in the model picker.";
  }
}

export class PairArchivedError extends Schema.TaggedError<PairArchivedError>()(
  "PairArchivedError",
  {},
) {
  override get message(): string {
    return "The pair was turned off for this thread. Ask the user to turn it back on.";
  }
}

export class PairKeyInvalidError extends Schema.TaggedError<PairKeyInvalidError>()(
  "PairKeyInvalidError",
  {},
) {
  override get message(): string {
    return "messageKey must be 1-64 letters, digits, underscores, or hyphens.";
  }
}

export class PairProtectedPathInvalidError extends Schema.TaggedError<PairProtectedPathInvalidError>()(
  "PairProtectedPathInvalidError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Protected path ${this.path} must be an existing file inside the worktree, given relative to it.`;
  }
}

export class PairDefaultMissingError extends Schema.TaggedError<PairDefaultMissingError>()(
  "PairDefaultMissingError",
  {},
) {
  override get message(): string {
    return "No default executor model is set. Ask the user which provider to pair with and pass providerInstanceId, or ask them to set Default delegation model in Pylon Settings → Integrations.";
  }
}

export class PairProviderUnavailableError extends Schema.TaggedError<PairProviderUnavailableError>()(
  "PairProviderUnavailableError",
  { providerInstanceId: Schema.String },
) {
  override get message(): string {
    return `Provider instance ${this.providerInstanceId} is not enabled, installed, or signed in. Ask the user to open Pylon Settings → Providers.`;
  }
}

export class PairModelUnavailableError extends Schema.TaggedError<PairModelUnavailableError>()(
  "PairModelUnavailableError",
  { providerInstanceId: Schema.String, model: Schema.NullOr(Schema.String) },
) {
  override get message(): string {
    return this.model === null
      ? `Provider instance ${this.providerInstanceId} offers no default model. Pass model explicitly.`
      : `Model ${this.model} is not offered by provider instance ${this.providerInstanceId}.`;
  }
}

export class PairRuntimeModeUnsupportedError extends Schema.TaggedError<PairRuntimeModeUnsupportedError>()(
  "PairRuntimeModeUnsupportedError",
  { providerInstanceId: Schema.String, runtimeMode: RuntimeMode },
) {
  override get message(): string {
    return `Provider instance ${this.providerInstanceId} does not support runtime mode ${this.runtimeMode}.`;
  }
}

export class PairExecutorBusyError extends Schema.TaggedError<PairExecutorBusyError>()(
  "PairExecutorBusyError",
  {},
) {
  override get message(): string {
    return "The executor is still working. Call pair_await, or pass steer: true to redirect it.";
  }
}

export class PairSteerLimitError extends Schema.TaggedError<PairSteerLimitError>()(
  "PairSteerLimitError",
  {},
) {
  override get message(): string {
    return "This executor turn was already steered once. Wait for it to finish, or call pair_stop.";
  }
}

export class PairMessageKeyConsumedError extends Schema.TaggedError<PairMessageKeyConsumedError>()(
  "PairMessageKeyConsumedError",
  { messageKey: Schema.String },
) {
  override get message(): string {
    return `messageKey ${this.messageKey} was rejected earlier. Choose a new key.`;
  }
}

export class PairTurnRejectedError extends Schema.TaggedError<PairTurnRejectedError>()(
  "PairTurnRejectedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `The executor could not start a turn: ${this.detail}`;
  }
}

export class PairFailedError extends Schema.TaggedError<PairFailedError>()("PairFailedError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The pair operation failed. Try again; if it persists, tell the user.";
  }
}

export const PairToolError = Schema.Union([
  McpCapabilityUnavailableError,
  PairLeadNotFoundError,
  PairDepthExceededError,
  PairLeadUnsupportedError,
  PairNotActiveError,
  PairArchivedError,
  PairKeyInvalidError,
  PairProtectedPathInvalidError,
  PairDefaultMissingError,
  PairProviderUnavailableError,
  PairModelUnavailableError,
  PairRuntimeModeUnsupportedError,
  PairExecutorBusyError,
  PairSteerLimitError,
  PairMessageKeyConsumedError,
  PairTurnRejectedError,
  PairFailedError,
]);
export type PairToolError = typeof PairToolError.Type;

// ---- Tools ----

const PairStartTool = Tool.make("pair_start", {
  description:
    "Link one persistent executor thread to this thread. The executor runs on a faster, cheaper model in your worktree; you plan, brief, and verify. Use only when the user asks to pair or has turned Pair on. Returns the existing executor if there is one. Requires Pylon delegation in Settings → Integrations.",
  parameters: PairStartInput,
  success: PairStartResult,
  failure: PairToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start a pair executor")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PairHandoffTool = Tool.make("pair_handoff", {
  description:
    "Send the executor a brief and start its next turn. Hand off a whole plan step at a time, not small nudges. Review its diff and re-run its checks yourself afterwards; the executor's report is not verification.",
  parameters: PairHandoffInput,
  success: PairHandoffResult,
  failure: PairToolError,
  dependencies,
})
  .annotate(Tool.Title, "Brief the pair executor")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PairAwaitTool = Tool.make("pair_await", {
  description:
    "Wait for the executor to stop running and return its final message and the files it changed. Returns immediately when it is idle, finished, failed, or waiting on the user.",
  parameters: PairAwaitInput,
  success: PairAwaitResult,
  failure: PairToolError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for the pair executor")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PairStopTool = Tool.make("pair_stop", {
  description:
    "Request an interrupt of the executor's running turn. interrupted=true means the request was accepted; confirm with pair_await.",
  success: PairStopResult,
  failure: PairToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop the pair executor")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const PairToolkit = Toolkit.make(
  PairStartTool,
  PairHandoffTool,
  PairAwaitTool,
  PairStopTool,
);
