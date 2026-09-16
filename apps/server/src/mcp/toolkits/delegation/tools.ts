/**
 * Delegation MCP toolkit declaration: tool schemas, results, and errors for
 * starting and managing child threads on other provider instances.
 *
 * @module mcp/toolkits/delegation/tools
 */
import {
  McpCapabilityUnavailableError,
  ProviderInstanceId,
  RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadDeletionReactor from "../../../orchestration/Services/ThreadDeletionReactor.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Crypto is not listed: it reaches the handlers as a layer requirement of
// `toLayer(make)`, the same way the pull request toolkit receives it.
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ThreadDeletionReactor.ThreadDeletionReactor,
  ProviderRegistry.ProviderRegistry,
  GitWorkflowService.GitWorkflowService,
  VcsStatusBroadcaster.VcsStatusBroadcaster,
  ServerSettings.ServerSettingsService,
];

const MAX_TASK_CHARS = 32_000;
// Prime Agent's MCP client cancels any call after 60 s, and each poll adds
// query time, so the budget stays well inside that.
const MAX_WAIT_SECONDS = 45;
const MAX_TITLE_CHARS = 200;
const MIN_RESULT_CHARS = 1_000;
const MAX_RESULT_CHARS = 60_000;

const DelegationKey = TrimmedNonEmptyString.annotate({
  description:
    "Your own identifier for this child: 1-64 letters, digits, underscores, or hyphens. Reusing a key returns the same child instead of creating another.",
});

const TaskText = TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_TASK_CHARS));

export const DelegatedThreadState = Schema.Literals([
  "queued",
  "running",
  "completed",
  "interrupted",
  "error",
  "archived",
]);

// ---- delegate_thread ----

export const DelegateThreadInput = Schema.Struct({
  delegationKey: DelegationKey,
  task: TaskText.annotate({
    description:
      "The child's first user message. Say what to do, where to look, and what to report back.",
  }),
  providerInstanceId: ProviderInstanceId.annotate({
    description:
      "The provider instance to run the child on, as listed in Pylon Settings → Providers.",
  }),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "A model slug or alias offered by that provider instance. Omit to use its default model.",
    }),
  ),
  title: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_TITLE_CHARS)).annotate({
      description: "Thread title. Defaults to the first line of the task.",
    }),
  ),
  runtimeMode: Schema.optional(
    RuntimeMode.annotate({
      description:
        "Permission mode for the child. Defaults to your own; you may choose only your own mode or approval-required.",
    }),
  ),
});
export type DelegateThreadInput = typeof DelegateThreadInput.Type;

export const DelegateThreadResult = Schema.Struct({
  delegationKey: Schema.String,
  threadId: Schema.String,
  created: Schema.Boolean,
  state: DelegatedThreadState,
  providerInstanceId: Schema.String,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  startedFromOrigin: Schema.Boolean,
  setupScriptRan: Schema.Literal(false),
});
export type DelegateThreadResult = typeof DelegateThreadResult.Type;

// ---- delegated_thread_status ----

export const DelegatedThreadStatusInput = Schema.Struct({
  delegationKey: DelegationKey,
  waitSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_WAIT_SECONDS })).annotate({
      description:
        "Wait up to this many seconds (at most 45) for the child's state to change before answering. Prefer 20 and call again while it is running.",
    }),
  ),
});
export type DelegatedThreadStatusInput = typeof DelegatedThreadStatusInput.Type;

export const DelegatedThreadStatusResult = Schema.Struct({
  delegationKey: Schema.String,
  threadId: Schema.String,
  state: DelegatedThreadState,
  waitedSeconds: Schema.Int,
  changed: Schema.Boolean,
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  latestTurn: Schema.NullOr(
    Schema.Struct({
      turnId: Schema.String,
      state: Schema.String,
      requestedAt: Schema.String,
      startedAt: Schema.NullOr(Schema.String),
      completedAt: Schema.NullOr(Schema.String),
    }),
  ),
  session: Schema.NullOr(
    Schema.Struct({
      status: Schema.String,
      lastError: Schema.NullOr(Schema.String),
    }),
  ),
  backgroundLiveness: Schema.NullOr(Schema.Literals(["working", "monitoring"])),
});
export type DelegatedThreadStatusResult = typeof DelegatedThreadStatusResult.Type;

// ---- delegated_thread_result ----

export const DelegatedThreadResultInput = Schema.Struct({
  delegationKey: DelegationKey,
  maxChars: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: MIN_RESULT_CHARS, maximum: MAX_RESULT_CHARS }),
    ).annotate({
      description: "Maximum characters of the child's final message to return. Default 20000.",
    }),
  ),
});
export type DelegatedThreadResultInput = typeof DelegatedThreadResultInput.Type;

export const DelegatedThreadResultResult = Schema.Struct({
  delegationKey: Schema.String,
  threadId: Schema.String,
  state: DelegatedThreadState,
  assistantMessage: Schema.NullOr(
    Schema.Struct({
      messageId: Schema.String,
      text: Schema.String,
      truncated: Schema.Boolean,
      createdAt: Schema.String,
    }),
  ),
  filesChanged: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.String,
      additions: Schema.Int,
      deletions: Schema.Int,
    }),
  ),
  turnCount: Schema.Int,
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
});
export type DelegatedThreadResultResult = typeof DelegatedThreadResultResult.Type;

// ---- send_to_delegated_thread ----

export const SendToDelegatedThreadInput = Schema.Struct({
  delegationKey: DelegationKey,
  messageKey: TrimmedNonEmptyString.annotate({
    description:
      "Your own identifier for this message, with the same rules as delegationKey. Reusing it never sends the message twice.",
  }),
  text: TaskText.annotate({ description: "The follow-up message for the child." }),
});
export type SendToDelegatedThreadInput = typeof SendToDelegatedThreadInput.Type;

export const SendToDelegatedThreadResult = Schema.Struct({
  delegationKey: Schema.String,
  threadId: Schema.String,
  accepted: Schema.Literal(true),
  messageId: Schema.String,
});
export type SendToDelegatedThreadResult = typeof SendToDelegatedThreadResult.Type;

// ---- interrupt_delegated_thread ----

export const InterruptDelegatedThreadInput = Schema.Struct({ delegationKey: DelegationKey });
export type InterruptDelegatedThreadInput = typeof InterruptDelegatedThreadInput.Type;

export const InterruptDelegatedThreadResult = Schema.Struct({
  delegationKey: Schema.String,
  threadId: Schema.String,
  interrupted: Schema.Boolean,
  state: DelegatedThreadState,
});
export type InterruptDelegatedThreadResult = typeof InterruptDelegatedThreadResult.Type;

// ---- Errors ----

export class DelegatingThreadNotFoundError extends Schema.TaggedError<DelegatingThreadNotFoundError>()(
  "DelegatingThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return "This thread is no longer available.";
  }
}

export class DelegationDepthExceededError extends Schema.TaggedError<DelegationDepthExceededError>()(
  "DelegationDepthExceededError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return "Delegated threads cannot delegate further. Report back to your parent instead.";
  }
}

export class DelegationKeyInvalidError extends Schema.TaggedError<DelegationKeyInvalidError>()(
  "DelegationKeyInvalidError",
  { field: Schema.Literals(["delegationKey", "messageKey"]) },
) {
  override get message(): string {
    return `${this.field} must be 1-64 letters, digits, underscores, or hyphens.`;
  }
}

export class DelegationProviderUnavailableError extends Schema.TaggedError<DelegationProviderUnavailableError>()(
  "DelegationProviderUnavailableError",
  { providerInstanceId: Schema.String },
) {
  override get message(): string {
    return `Provider instance ${this.providerInstanceId} is not enabled, installed, or signed in. Ask the user to open Pylon Settings → Providers.`;
  }
}

export class DelegationModelUnavailableError extends Schema.TaggedError<DelegationModelUnavailableError>()(
  "DelegationModelUnavailableError",
  { providerInstanceId: Schema.String, model: Schema.NullOr(Schema.String) },
) {
  override get message(): string {
    return this.model === null
      ? `Provider instance ${this.providerInstanceId} offers no default model. Pass model explicitly.`
      : `Model ${this.model} is not offered by provider instance ${this.providerInstanceId}.`;
  }
}

export class DelegationRuntimeModeEscalationError extends Schema.TaggedError<DelegationRuntimeModeEscalationError>()(
  "DelegationRuntimeModeEscalationError",
  { parentMode: RuntimeMode, requested: RuntimeMode },
) {
  override get message(): string {
    return `A child may run in your mode (${this.parentMode}) or in approval-required, not ${this.requested}.`;
  }
}

export class DelegationRuntimeModeUnsupportedError extends Schema.TaggedError<DelegationRuntimeModeUnsupportedError>()(
  "DelegationRuntimeModeUnsupportedError",
  { providerInstanceId: Schema.String, runtimeMode: RuntimeMode },
) {
  override get message(): string {
    return `Provider instance ${this.providerInstanceId} does not support runtime mode ${this.runtimeMode}.`;
  }
}

export class DelegationLimitExceededError extends Schema.TaggedError<DelegationLimitExceededError>()(
  "DelegationLimitExceededError",
  { limit: Schema.Int },
) {
  override get message(): string {
    return `You already have ${this.limit} children queued or running. Wait for one to finish.`;
  }
}

export class DelegationKeyConsumedError extends Schema.TaggedError<DelegationKeyConsumedError>()(
  "DelegationKeyConsumedError",
  { delegationKey: Schema.String },
) {
  override get message(): string {
    return `delegationKey ${this.delegationKey} was used by an attempt that was cleaned up. Choose a new key.`;
  }
}

export class DelegationWorktreeError extends Schema.TaggedError<DelegationWorktreeError>()(
  "DelegationWorktreeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Could not prepare a worktree for the child: ${this.detail}`;
  }
}

export class DelegatedThreadNotFoundError extends Schema.TaggedError<DelegatedThreadNotFoundError>()(
  "DelegatedThreadNotFoundError",
  { delegationKey: Schema.String },
) {
  override get message(): string {
    return `No child thread exists for delegationKey ${this.delegationKey}.`;
  }
}

export class DelegatedThreadArchivedError extends Schema.TaggedError<DelegatedThreadArchivedError>()(
  "DelegatedThreadArchivedError",
  { delegationKey: Schema.String },
) {
  override get message(): string {
    return "The child thread is archived. Ask the user to unarchive it.";
  }
}

export class DelegatedThreadBusyError extends Schema.TaggedError<DelegatedThreadBusyError>()(
  "DelegatedThreadBusyError",
  { delegationKey: Schema.String, state: DelegatedThreadState },
) {
  override get message(): string {
    return "The child is still working. Call delegated_thread_status with waitSeconds first.";
  }
}

export class DelegatedMessageKeyConsumedError extends Schema.TaggedError<DelegatedMessageKeyConsumedError>()(
  "DelegatedMessageKeyConsumedError",
  { messageKey: Schema.String },
) {
  override get message(): string {
    return `messageKey ${this.messageKey} was rejected earlier. Choose a new key.`;
  }
}

export class DelegatedThreadTurnRejectedError extends Schema.TaggedError<DelegatedThreadTurnRejectedError>()(
  "DelegatedThreadTurnRejectedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `The child could not start a turn: ${this.detail}`;
  }
}

export class DelegationFailedError extends Schema.TaggedError<DelegationFailedError>()(
  "DelegationFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Delegation failed. Try again; if it persists, tell the user.";
  }
}

export const DelegationToolError = Schema.Union([
  McpCapabilityUnavailableError,
  DelegatingThreadNotFoundError,
  DelegationDepthExceededError,
  DelegationKeyInvalidError,
  DelegationProviderUnavailableError,
  DelegationModelUnavailableError,
  DelegationRuntimeModeEscalationError,
  DelegationRuntimeModeUnsupportedError,
  DelegationLimitExceededError,
  DelegationKeyConsumedError,
  DelegationWorktreeError,
  DelegatedThreadNotFoundError,
  DelegatedThreadArchivedError,
  DelegatedThreadBusyError,
  DelegatedMessageKeyConsumedError,
  DelegatedThreadTurnRejectedError,
  DelegationFailedError,
]);
export type DelegationToolError = typeof DelegationToolError.Type;

// ---- Tools ----
// Annotations are written out per tool: a generic helper over `Tool.Any`
// erases the tool name type that `DelegationToolkit.of` checks against.

const DelegateThreadTool = Tool.make("delegate_thread", {
  description:
    "Start a child Pylon thread on another provider instance to work on a task in its own git worktree, then return immediately. Children are ordinary threads the user can open. Use delegated_thread_status to wait for it, delegated_thread_result to read its answer and changed files, and send_to_delegated_thread for follow-ups. Reusing a delegationKey returns the existing child. Requires Agent delegation in Pylon Settings → Integrations. A child runs in your own interaction mode, so a plan-mode parent gets a plan-mode child.",
  parameters: DelegateThreadInput,
  success: DelegateThreadResult,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delegate a task to a child thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DelegatedThreadStatusTool = Tool.make("delegated_thread_status", {
  description:
    "Report a child thread's state (queued, running, completed, interrupted, error, archived) and whether it is waiting on an approval or a question. Pass waitSeconds to wait up to 45 seconds until something changes; prefer 20 and call again while it is running.",
  parameters: DelegatedThreadStatusInput,
  success: DelegatedThreadStatusResult,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Check a delegated thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DelegatedThreadResultTool = Tool.make("delegated_thread_result", {
  description:
    "Read a child thread's latest assistant message and the files it changed across all its turns, with its worktree path and branch so you can inspect or merge the work yourself. An archived child returns no message or files; ask the user to unarchive it first.",
  parameters: DelegatedThreadResultInput,
  success: DelegatedThreadResultResult,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a delegated thread's result")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SendToDelegatedThreadTool = Tool.make("send_to_delegated_thread", {
  description:
    "Send a follow-up message to a child thread that is not currently running, starting its next turn. Fails while the child is busy; wait with delegated_thread_status first. Reusing a messageKey never sends twice.",
  parameters: SendToDelegatedThreadInput,
  success: SendToDelegatedThreadResult,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message a delegated thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const InterruptDelegatedThreadTool = Tool.make("interrupt_delegated_thread", {
  description:
    "Interrupt a child thread's running or queued turn. Returns interrupted=false without doing anything when the child is not running.",
  parameters: InterruptDelegatedThreadInput,
  success: InterruptDelegatedThreadResult,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Interrupt a delegated thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DelegationToolkit = Toolkit.make(
  DelegateThreadTool,
  DelegatedThreadStatusTool,
  DelegatedThreadResultTool,
  SendToDelegatedThreadTool,
  InterruptDelegatedThreadTool,
);
