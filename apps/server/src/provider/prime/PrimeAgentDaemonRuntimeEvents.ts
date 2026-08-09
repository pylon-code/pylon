import {
  RuntimeItemId,
  RuntimeTaskId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
  type ToolLifecycleItemType,
  type TurnId,
} from "@t3tools/contracts";

import type {
  PrimeDaemonEvent,
  PrimeDaemonMessage,
  PrimeDaemonUsage,
} from "./PrimeAgentDaemonEvents.ts";

type RuntimeEventDraft<Event> = Event extends ProviderRuntimeEvent
  ? Omit<Event, "eventId" | "createdAt">
  : never;

/** A canonical runtime event before the adapter gives it a unique stamp. */
export type PrimeAgentRuntimeEventDraft = RuntimeEventDraft<ProviderRuntimeEvent>;

interface RuntimeEventContext {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
}

const MAX_TEXT_LENGTH = 100_000;
const MAX_SCALAR_LENGTH = 4_000;
const MAX_SCALAR_FIELDS = 32;

type SafeScalar = string | number | boolean | null;
type SafeData = Readonly<Record<string, SafeScalar>>;

function bounded(value: string, maximum = MAX_TEXT_LENGTH): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function boundedNonEmpty(value: string | undefined, maximum = MAX_TEXT_LENGTH): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return bounded(value, maximum);
}

function boundedScalarData(value: SafeData | undefined): SafeData | undefined {
  if (value === undefined) return undefined;

  const output: Record<string, SafeScalar> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_SCALAR_FIELDS)) {
    const safeKey = bounded(key, MAX_SCALAR_LENGTH);
    if (safeKey.length === 0) continue;
    if (typeof item === "string") output[safeKey] = bounded(item, MAX_SCALAR_LENGTH);
    else if (typeof item !== "number" || Number.isFinite(item)) output[safeKey] = item;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function runtimeBase(input: RuntimeEventContext) {
  return {
    provider: input.provider,
    ...(input.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: input.providerInstanceId }),
    threadId: input.threadId,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
  };
}

function assistantItemId(turnId: TurnId | undefined): RuntimeItemId | undefined {
  return turnId === undefined ? undefined : RuntimeItemId.make(`assistant:${turnId}`);
}

function reasoningItemId(turnId: TurnId | undefined): RuntimeItemId | undefined {
  return turnId === undefined ? undefined : RuntimeItemId.make(`reasoning:${turnId}`);
}

function normalizedToolNameTokens(toolName: string): ReadonlyArray<string> {
  return toolName
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function canonicalToolItemType(toolName: string): ToolLifecycleItemType {
  const tokens = normalizedToolNameTokens(toolName);
  if (tokens.some((token) => token === "bash" || token === "shell" || token === "ipython")) {
    return "command_execution";
  }
  if (
    tokens.some((token) => token === "edit" || token === "write" || token === "applypatch") ||
    tokens.some((token, index) => token === "apply" && tokens[index + 1] === "patch")
  ) {
    return "file_change";
  }
  return "dynamic_tool_call";
}

function toolLifecycleDraft(
  input: RuntimeEventContext & {
    readonly lifecycle: "item.started" | "item.updated" | "item.completed";
    readonly toolCallId: string;
    readonly toolName: string;
    readonly text?: string | undefined;
    readonly data?: SafeData | undefined;
    readonly failed?: boolean | undefined;
  },
): PrimeAgentRuntimeEventDraft | undefined {
  if (input.toolCallId.trim().length === 0) return undefined;
  const title = boundedNonEmpty(input.toolName, MAX_SCALAR_LENGTH);
  const detail = boundedNonEmpty(input.text);
  const data = boundedScalarData(input.data);
  return {
    ...runtimeBase(input),
    type: input.lifecycle,
    itemId: RuntimeItemId.make(bounded(input.toolCallId, MAX_SCALAR_LENGTH)),
    payload: {
      itemType: canonicalToolItemType(input.toolName),
      status:
        input.lifecycle === "item.completed"
          ? input.failed
            ? "failed"
            : "completed"
          : "inProgress",
      ...(title === undefined ? {} : { title }),
      ...(detail === undefined ? {} : { detail }),
      ...(data === undefined ? {} : { data }),
    },
  };
}

function validCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function turnUsage(usage: PrimeDaemonUsage) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
  };
}

type PrimeDaemonAssistantMessage = Extract<PrimeDaemonMessage, { readonly role: "assistant" }>;

function assistantMessages(
  messages: ReadonlyArray<PrimeDaemonMessage>,
): ReadonlyArray<PrimeDaemonAssistantMessage> {
  return messages.filter(
    (message): message is PrimeDaemonAssistantMessage => message.role === "assistant",
  );
}

function aggregateAssistantUsage(
  messages: ReadonlyArray<PrimeDaemonAssistantMessage>,
): PrimeDaemonUsage {
  return messages.reduce<PrimeDaemonUsage>(
    (total, message) => ({
      inputTokens: total.inputTokens + message.usage.inputTokens,
      outputTokens: total.outputTokens + message.usage.outputTokens,
      cachedInputTokens: total.cachedInputTokens + message.usage.cachedInputTokens,
      cacheWriteTokens: total.cacheWriteTokens + message.usage.cacheWriteTokens,
      totalTokens: total.totalTokens + message.usage.totalTokens,
      totalCostUsd: total.totalCostUsd + message.usage.totalCostUsd,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    },
  );
}

function tokenUsageDraft(
  input: RuntimeEventContext,
  usage: PrimeDaemonUsage,
): PrimeAgentRuntimeEventDraft | undefined {
  const usedTokens = validCount(usage.totalTokens);
  if (usedTokens === undefined) return undefined;
  const inputTokens = validCount(usage.inputTokens);
  const cachedInputTokens = validCount(usage.cachedInputTokens);
  const outputTokens = validCount(usage.outputTokens);
  return {
    ...runtimeBase(input),
    type: "thread.token-usage.updated",
    payload: {
      usage: {
        usedTokens,
        ...(inputTokens === undefined ? {} : { inputTokens, lastInputTokens: inputTokens }),
        ...(cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens, lastOutputTokens: outputTokens }),
        lastUsedTokens: usedTokens,
      },
    },
  };
}

function childUsage(child: Extract<PrimeDaemonEvent, { readonly _tag: "ChildUpdated" }>["child"]) {
  const totalTokens = validCount(child.tokenCount);
  if (totalTokens === undefined) return undefined;
  const toolUses = validCount(child.toolUseCount);
  const durationMs = validCount(child.durationMs);
  return {
    totalTokens,
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function childDraft(
  input: RuntimeEventContext,
  child: Extract<PrimeDaemonEvent, { readonly _tag: "ChildUpdated" }>["child"],
): PrimeAgentRuntimeEventDraft | undefined {
  const childId = boundedNonEmpty(child.id, MAX_SCALAR_LENGTH);
  if (childId === undefined) return undefined;
  const description = boundedNonEmpty(child.label, MAX_SCALAR_LENGTH) ?? childId;
  const model = boundedNonEmpty(child.model, MAX_SCALAR_LENGTH);
  const parentAgentId = boundedNonEmpty(child.parentId, MAX_SCALAR_LENGTH);
  const typedUsage = childUsage(child);
  const title = description;
  const linkage = {
    taskType: "subagent",
    agentKind: "agent",
    title,
    ...(model === undefined ? {} : { model }),
    ...(parentAgentId === undefined ? {} : { parentAgentId }),
    timelineBypass: true,
  } as const;
  const taskId = RuntimeTaskId.make(childId);

  switch (child.status) {
    case "queued":
      return {
        ...runtimeBase(input),
        type: "task.started",
        payload: { taskId, description, ...linkage },
      };
    case "running": {
      const lastToolName = boundedNonEmpty(child.activity?.toolName, MAX_SCALAR_LENGTH);
      if (child.activity?.kind === "waiting") {
        return {
          ...runtimeBase(input),
          type: "task.updated",
          payload: { taskId, status: "waiting", description, ...linkage },
        };
      }
      const summary = boundedNonEmpty(child.recap ?? child.answerPreview, MAX_SCALAR_LENGTH);
      return {
        ...runtimeBase(input),
        type: "task.progress",
        payload: {
          taskId,
          description,
          status: "running",
          ...(summary === undefined ? {} : { summary }),
          ...(typedUsage === undefined ? {} : { typedUsage }),
          ...(lastToolName === undefined ? {} : { lastToolName }),
          ...linkage,
        },
      };
    }
    case "done":
    case "error":
    case "cancelled": {
      const summary = boundedNonEmpty(
        child.error ?? child.answerPreview ?? child.recap,
        MAX_SCALAR_LENGTH,
      );
      return {
        ...runtimeBase(input),
        type: "task.completed",
        payload: {
          taskId,
          status:
            child.status === "done" ? "completed" : child.status === "error" ? "failed" : "stopped",
          ...(summary === undefined ? {} : { summary }),
          ...(typedUsage === undefined ? {} : { typedUsage }),
          ...linkage,
        },
      };
    }
  }
}

function compactionItemId(input: RuntimeEventContext): RuntimeItemId {
  return RuntimeItemId.make(`compaction:${input.turnId ?? input.threadId}`);
}

function refinementData(
  event: Extract<PrimeDaemonEvent, { readonly _tag: "RefinementCompleted" }>,
) {
  return boundedScalarData({
    appliedCount: event.appliedCount,
    failedCount: event.failedCount,
    ...(event.scope === undefined ? {} : { scope: event.scope }),
    ...(event.rollbackOf === undefined ? {} : { rollbackOf: event.rollbackOf }),
  });
}

/**
 * Purely maps one bounded daemon event into zero or more provider-neutral
 * runtime drafts. The caller gives every returned draft its own event stamp.
 */
export function mapPrimeAgentDaemonRuntimeEventDrafts(input: {
  readonly event: PrimeDaemonEvent;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly assistantTextStreamed?: boolean | undefined;
}): ReadonlyArray<PrimeAgentRuntimeEventDraft> {
  const context: RuntimeEventContext = input;
  const base = runtimeBase(context);
  const event = input.event;

  switch (event._tag) {
    case "RunStarted":
      return [{ ...base, type: "session.state.changed", payload: { state: "running" } }];
    case "RunCompleted": {
      const ready: PrimeAgentRuntimeEventDraft = {
        ...base,
        type: "session.state.changed",
        payload: { state: "ready" },
      };
      if (input.turnId === undefined) return [ready];

      const runMessages = assistantMessages(event.messages);
      const message = runMessages.at(-1);
      if (message === undefined) {
        return [
          {
            ...base,
            type: "turn.completed",
            payload: {
              state: "failed",
              errorMessage: "Prime Agent completed the run without an assistant message.",
            },
          },
          ready,
        ];
      }

      const errorMessage = boundedNonEmpty(message.errorMessage);
      const state =
        message.stopReason === "aborted"
          ? "cancelled"
          : message.stopReason === "error" || errorMessage !== undefined
            ? "failed"
            : "completed";
      const usage = aggregateAssistantUsage(runMessages);
      const completed: PrimeAgentRuntimeEventDraft = {
        ...base,
        type: "turn.completed",
        payload: {
          state,
          stopReason: message.stopReason,
          usage: turnUsage(usage),
          totalCostUsd: usage.totalCostUsd,
          ...(errorMessage === undefined ? {} : { errorMessage }),
        },
      };
      const tokenDraft = tokenUsageDraft(context, message.usage);
      return tokenDraft === undefined ? [completed, ready] : [completed, tokenDraft, ready];
    }
    case "TurnStarted":
      return [];
    case "MessageStarted": {
      const itemId = event.message.role === "assistant" ? assistantItemId(input.turnId) : undefined;
      return itemId === undefined
        ? []
        : [
            {
              ...base,
              type: "item.started",
              itemId,
              payload: { itemType: "assistant_message", status: "inProgress" },
            },
          ];
    }
    case "MessageCompleted": {
      const itemId = event.message.role === "assistant" ? assistantItemId(input.turnId) : undefined;
      if (itemId === undefined || event.message.role !== "assistant") return [];
      const errorMessage = boundedNonEmpty(event.message.errorMessage);
      const failed = event.message.stopReason === "error" || errorMessage !== undefined;
      const completed: PrimeAgentRuntimeEventDraft = {
        ...base,
        type: "item.completed",
        itemId,
        payload: {
          itemType: "assistant_message",
          status: failed ? "failed" : "completed",
          ...(errorMessage === undefined ? {} : { detail: errorMessage }),
        },
      };
      const finalText =
        input.assistantTextStreamed === false ? boundedNonEmpty(event.message.text) : undefined;
      return finalText === undefined
        ? [completed]
        : [
            {
              ...base,
              type: "content.delta",
              itemId,
              payload: { streamKind: "assistant_text", delta: finalText },
            },
            completed,
          ];
    }
    case "AssistantStream": {
      if (event.kind === "toolCall" || event.phase === "done" || event.phase === "error") return [];
      if (event.kind === "text") {
        const itemId = assistantItemId(input.turnId);
        return event.phase !== "delta" || itemId === undefined || event.delta === undefined
          ? []
          : [
              {
                ...base,
                type: "content.delta",
                itemId,
                payload: {
                  streamKind: "assistant_text",
                  delta: bounded(event.delta),
                  ...(event.contentIndex === undefined ? {} : { contentIndex: event.contentIndex }),
                },
              },
            ];
      }
      if (event.kind === "thinking") {
        const itemId = reasoningItemId(input.turnId);
        if (itemId === undefined) return [];
        if (event.phase === "start") {
          return [
            {
              ...base,
              type: "item.started",
              itemId,
              payload: { itemType: "reasoning", status: "inProgress" },
            },
          ];
        }
        if (event.phase === "delta" && event.delta !== undefined) {
          return [
            {
              ...base,
              type: "content.delta",
              itemId,
              payload: {
                streamKind: "reasoning_text",
                delta: bounded(event.delta),
                ...(event.contentIndex === undefined ? {} : { contentIndex: event.contentIndex }),
              },
            },
          ];
        }
        if (event.phase === "end") {
          return [
            {
              ...base,
              type: "item.completed",
              itemId,
              payload: { itemType: "reasoning", status: "completed" },
            },
          ];
        }
      }
      return [];
    }
    case "ToolStarted": {
      const draft = toolLifecycleDraft({
        ...context,
        lifecycle: "item.started",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        data: event.input,
      });
      return draft === undefined ? [] : [draft];
    }
    case "ToolProgress": {
      const draft = toolLifecycleDraft({
        ...context,
        lifecycle: "item.updated",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        text: event.text,
      });
      return draft === undefined ? [] : [draft];
    }
    case "ToolCompleted": {
      const draft = toolLifecycleDraft({
        ...context,
        lifecycle: "item.completed",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        text: event.text,
        failed: event.isError,
      });
      return draft === undefined ? [] : [draft];
    }
    case "TurnCompleted":
      return [];
    case "SessionInfoChanged": {
      const name = boundedNonEmpty(event.name, MAX_SCALAR_LENGTH);
      return name === undefined
        ? []
        : [{ ...base, type: "thread.metadata.updated", payload: { name } }];
    }
    case "CompactionStarted": {
      const detail = boundedNonEmpty(event.instructions ?? event.reason, MAX_SCALAR_LENGTH);
      return [
        {
          ...base,
          type: "item.started",
          itemId: compactionItemId(context),
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            title: "Context compaction",
            ...(detail === undefined ? {} : { detail }),
          },
        },
      ];
    }
    case "CompactionCompleted": {
      const detail = boundedNonEmpty(event.errorMessage ?? event.summary ?? event.reason);
      return [
        {
          ...base,
          type: "item.completed",
          itemId: compactionItemId(context),
          payload: {
            itemType: "context_compaction",
            status: event.aborted || event.errorMessage !== undefined ? "failed" : "completed",
            title: "Context compaction",
            ...(detail === undefined ? {} : { detail }),
            data: {
              reason: bounded(event.reason, MAX_SCALAR_LENGTH),
              aborted: event.aborted,
              willRetry: event.willRetry,
              ...(event.tokensBefore === undefined ? {} : { tokensBefore: event.tokensBefore }),
            },
          },
        },
      ];
    }
    case "RetryStarted":
      return [
        {
          ...base,
          type: "runtime.warning",
          payload: {
            message: `Prime Agent retry ${event.attempt} of ${event.maxAttempts}`,
            detail: {
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              errorMessage: bounded(event.errorMessage, MAX_SCALAR_LENGTH),
            },
          },
        },
      ];
    case "RetryCompleted":
      return event.success
        ? [
            {
              ...base,
              type: "session.state.changed",
              payload: { state: "running", reason: `retry ${event.attempt} succeeded` },
            },
          ]
        : [
            {
              ...base,
              type: "runtime.error",
              payload: {
                message:
                  boundedNonEmpty(event.finalError) ?? `Prime Agent retry ${event.attempt} failed`,
                class: "provider_error",
              },
            },
          ];
    case "AuthStale":
      return [
        {
          ...base,
          type: "auth.status",
          payload: {
            error: `Authentication for ${bounded(event.provider, MAX_SCALAR_LENGTH)} is stale`,
          },
        },
      ];
    case "ChildUpdated": {
      const draft = childDraft(context, event.child);
      return draft === undefined ? [] : [draft];
    }
    case "RefinementCompleted": {
      const id = boundedNonEmpty(event.id, MAX_SCALAR_LENGTH);
      if (id === undefined) return [];
      const detail = boundedNonEmpty(event.summary, MAX_SCALAR_LENGTH);
      const data = refinementData(event);
      return [
        {
          ...base,
          type: "item.completed",
          itemId: RuntimeItemId.make(`refinement:${id}`),
          payload: {
            itemType: "dynamic_tool_call",
            status: event.failedCount > 0 ? "failed" : "completed",
            title: "Harness refinement",
            ...(detail === undefined ? {} : { detail }),
            ...(data === undefined ? {} : { data }),
          },
        },
      ];
    }
    case "RefinementFailed":
      return [
        {
          ...base,
          type: "runtime.error",
          payload: {
            message: boundedNonEmpty(event.error) ?? "Prime Agent refinement failed",
            class: "provider_error",
          },
        },
      ];
    case "ConnectionStatus": {
      const reason = boundedNonEmpty(event.error, MAX_SCALAR_LENGTH);
      return [
        {
          ...base,
          type: "session.state.changed",
          payload: {
            state: event.status === "connected" ? "ready" : "starting",
            ...(reason === undefined ? {} : { reason }),
          },
        },
      ];
    }
    case "SessionClosed": {
      const reason = boundedNonEmpty(event.error);
      return [
        {
          ...base,
          type: "session.exited",
          payload: {
            exitKind: reason === undefined ? "graceful" : "error",
            ...(reason === undefined ? {} : { reason }),
          },
        },
      ];
    }
    case "AgentMessageSent":
    case "QueueChanged":
    case "ThinkingLevelChanged":
    case "ServiceTierChanged":
    case "RecapUpdated":
    case "GoalUpdated":
    case "BashStarted":
    case "BashOutput":
    case "BashCompleted":
    case "SideQuestionUpdated":
    case "SessionReplaced":
    case "SessionResynced":
    case "SessionStatus":
    case "ExtensionRequest":
    case "ExtensionError":
    case "HeartbeatsChanged":
    case "Ignored":
      return [];
  }
}
