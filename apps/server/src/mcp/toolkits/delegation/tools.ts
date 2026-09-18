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
      "One bounded task: specify relevant files, acceptance criteria, exclusions, and a concise final report of changes, checks, and unresolved issues. Do not copy the full conversation.",
  }),
  providerInstanceId: Schema.optional(
    ProviderInstanceId.annotate({
      description:
        "Provider instance to run the child on, as listed in Pylon Settings → Providers. Omit unless the user named a provider: Pylon then uses the user's default delegation model.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Model slug or alias. Omit unless the user named a model. With providerInstanceId it defaults to that provider's default model; without it, to the user's default delegation model.",
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
        "Omit unless the user asks for a permission mode. Pylon applies the user's child permission setting. You may only choose your own mode or approval-required.",
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
  /**
   * Which part of the provider and model came from the user's default delegation
   * model. Present only when this call created the child; a reused child's
   * original choice is not recorded.
   */
  defaultApplied: Schema.optional(Schema.Literals(["none", "provider", "provider-and-model"])),
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
        "Wait up to this many seconds (at most 45) for the child's state to change before answering. Use 45 when waiting is necessary; do independent work before checking again. Completed or blocked children return immediately.",
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
      description:
        "Maximum characters of the child's final message to return. Default 4000. Expand truncated results before accepting work; at the 60000 limit, inspect the child thread or ask for a concise handoff.",
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

export class DelegationKeyReservedError extends Schema.TaggedError<DelegationKeyReservedError>()(
  "DelegationKeyReservedError",
  { delegationKey: Schema.String },
) {
  override get message(): string {
    return `delegationKey ${this.delegationKey} is reserved for the pair executor. Use the pair tools, or choose another key.`;
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

export class DelegationDefaultMissingError extends Schema.TaggedError<DelegationDefaultMissingError>()(
  "DelegationDefaultMissingError",
  {},
) {
  override get message(): string {
    return "No default delegation model is set. Ask the user which provider to use and pass providerInstanceId, or ask them to set Default delegation model in Pylon Settings → Integrations.";
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
  DelegationKeyReservedError,
  DelegationProviderUnavailableError,
  DelegationModelUnavailableError,
  DelegationDefaultMissingError,
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
    "Start a separate Pylon thread in its own worktree and return immediately. Keep small or tightly coupled work local. For worthwhile independent work, follow the current preference returned by read_delegation_skill; default to built-in agents. Explicit user instructions override the preference. Availability alone is not a request to delegate. First load read_delegation_skill once for the workflow, defaults, waiting, and review rules. Reusing a delegationKey returns the existing child. Requires Pylon delegation in Settings → Integrations.",
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
    "Report a child thread's state (queued, running, completed, interrupted, error, archived) and whether it is waiting on an approval or a question. Pass waitSeconds to wait up to 45 seconds until something changes; use 45 when waiting is necessary. Completed children and children needing approval or input return immediately. Do independent work before checking again; avoid short polling and unchanged progress updates. While Pylon delegation is enabled, child lifecycle changes can queue automatic parent follow-through at an eligible idle boundary; see read_delegation_skill for limits.",
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
    "Request an interrupt of a child thread's running or queued turn. interrupted=true means the request was accepted, not that the turn has stopped; confirm with delegated_thread_status. Returns interrupted=false without doing anything when the child is not running.",
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

const ReadDelegationSkillTool = Tool.make("read_delegation_skill", {
  description:
    "Read the Pylon delegation skill: choose local work, built-in subagents, or Pylon child threads, then manage and review them efficiently. Read when choosing a delegation method for a task: includes the current project preference. No child is started. Requires the delegation capability.",
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read the Pylon delegation skill")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DelegationToolkit = Toolkit.make(
  ReadDelegationSkillTool,
  DelegateThreadTool,
  DelegatedThreadStatusTool,
  DelegatedThreadResultTool,
  SendToDelegatedThreadTool,
  InterruptDelegatedThreadTool,
);
