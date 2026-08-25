// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

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
import type { PrimeAgentDaemonSessionStats } from "./PrimeAgentDaemonSessionRuntime.ts";
import {
  PRIME_AGENT_FINISHED_WITHOUT_FINAL_RESPONSE,
  PRIME_AGENT_STOPPED_WITHOUT_FINAL_RESPONSE,
  PRIME_AGENT_TURN_FAILED,
  primeAgentMissingFinalResponseDetail,
} from "./PrimeAgentTerminalResponse.ts";

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
  readonly assistantItemId?: RuntimeItemId | undefined;
}

const MAX_TEXT_LENGTH = 100_000;
const MAX_SCALAR_LENGTH = 4_000;
const PRIME_TOOL_ITEM_ID_HASH_LENGTH = 32;

function bounded(value: string, maximum = MAX_TEXT_LENGTH): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function boundedNonEmpty(value: string | undefined, maximum = MAX_TEXT_LENGTH): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return bounded(value, maximum);
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

export function mapPrimeAgentContextUsageDraft(input: {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly threadId: ThreadId;
  readonly stats: PrimeAgentDaemonSessionStats;
  readonly compactsAutomatically: boolean;
}): PrimeAgentRuntimeEventDraft {
  const base = runtimeBase(input);
  if (input.stats.contextUsage === undefined) {
    return {
      ...base,
      type: "thread.token-usage.cleared",
      payload: { reason: "unavailable" },
    };
  }
  if (input.stats.contextUsage.usedTokens === null) {
    return {
      ...base,
      type: "thread.token-usage.cleared",
      payload: { reason: "unknown" },
    };
  }
  return {
    ...base,
    type: "thread.token-usage.updated",
    payload: {
      usage: {
        usedTokens: input.stats.contextUsage.usedTokens,
        maxTokens: input.stats.contextUsage.maxTokens,
        compactsAutomatically: input.compactsAutomatically,
      },
    },
  };
}

function assistantItemId(input: RuntimeEventContext): RuntimeItemId | undefined {
  return (
    input.assistantItemId ??
    (input.turnId === undefined ? undefined : RuntimeItemId.make(`assistant:${input.turnId}`))
  );
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

function canonicalToolTitle(toolName: string): string {
  switch (toolName.trim().toLowerCase()) {
    case "ipython":
    case "functions.ipython":
      return "IPython";
    case "bash":
    case "functions.bash":
      return "Shell";
    case "edit":
    case "functions.edit":
    case "apply_patch":
      return "Edit";
    case "read":
    case "functions.read":
      return "Read";
    case "grep":
    case "glob":
    case "find":
    case "search":
      return "Search";
    case "websearch":
    case "functions.websearch":
      return "Web search";
    case "attach_image":
    case "functions.attach_image":
      return "Image";
    default:
      return "Tool";
  }
}

// Native Prime tool-call ids stay behind the adapter boundary. The opaque
// digest still gives every update for one call the same canonical identity.
export function canonicalPrimeToolItemId(toolCallId: string): RuntimeItemId {
  const digest = NodeCrypto.createHash("sha256").update(toolCallId, "utf8").digest("hex");
  return RuntimeItemId.make(`prime-tool:${digest.slice(0, PRIME_TOOL_ITEM_ID_HASH_LENGTH)}`);
}

function toolLifecycleDraft(
  input: RuntimeEventContext & {
    readonly lifecycle: "item.started" | "item.updated" | "item.completed";
    readonly toolCallId: string;
    readonly toolName: string;
    readonly failed?: boolean | undefined;
  },
): PrimeAgentRuntimeEventDraft | undefined {
  if (input.toolCallId.trim().length === 0) return undefined;
  const title = canonicalToolTitle(input.toolName);
  return {
    ...runtimeBase(input),
    type: input.lifecycle,
    itemId: canonicalPrimeToolItemId(input.toolCallId),
    payload: {
      itemType: canonicalToolItemType(input.toolName),
      status:
        input.lifecycle === "item.completed"
          ? input.failed
            ? "failed"
            : "completed"
          : "inProgress",
      title,
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
  const messageable =
    (child.status === "queued" || child.status === "running") &&
    child.activeSessionId !== undefined &&
    child.activeSessionId.trim().length > 0;
  const linkage = {
    taskType: "subagent",
    agentKind: "agent",
    title,
    messageable,
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
      return {
        ...runtimeBase(input),
        type: "task.progress",
        payload: {
          taskId,
          description,
          status: "running",
          ...(typedUsage === undefined ? {} : { typedUsage }),
          ...(lastToolName === undefined ? {} : { lastToolName }),
          ...linkage,
        },
      };
    }
    case "done":
    case "error":
    case "cancelled": {
      return {
        ...runtimeBase(input),
        type: "task.completed",
        payload: {
          taskId,
          status:
            child.status === "done" ? "completed" : child.status === "error" ? "failed" : "stopped",
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

function retryItemId(input: RuntimeEventContext): RuntimeItemId {
  return RuntimeItemId.make(`retry:${input.turnId ?? input.threadId}`);
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
  readonly assistantItemId?: RuntimeItemId | undefined;
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
      const nativeError = boundedNonEmpty(message?.errorMessage);
      const state =
        message?.stopReason === "aborted"
          ? "cancelled"
          : message?.stopReason === "error" || nativeError !== undefined
            ? "failed"
            : "completed";
      const hasFinalResponse =
        boundedNonEmpty(message?.text) !== undefined &&
        message?.stopReason !== "toolUse" &&
        message?.toolCalls.length === 0;
      const missingFinalResponse = state !== "cancelled" && !hasFinalResponse;
      const usage = event.usageOverride ?? aggregateAssistantUsage(runMessages);
      const completed: PrimeAgentRuntimeEventDraft = {
        ...base,
        type: "turn.completed",
        payload: {
          state,
          ...(message === undefined ? {} : { stopReason: message.stopReason }),
          usage: turnUsage(usage),
          totalCostUsd: usage.totalCostUsd,
          ...(state !== "failed"
            ? {}
            : {
                errorMessage: missingFinalResponse
                  ? PRIME_AGENT_STOPPED_WITHOUT_FINAL_RESPONSE
                  : PRIME_AGENT_TURN_FAILED,
              }),
        },
      };
      const terminalNotice: ReadonlyArray<PrimeAgentRuntimeEventDraft> = !missingFinalResponse
        ? []
        : state === "failed"
          ? [
              {
                ...base,
                type: "runtime.error",
                payload: {
                  message: PRIME_AGENT_STOPPED_WITHOUT_FINAL_RESPONSE,
                  class: "provider_error",
                  detail: primeAgentMissingFinalResponseDetail("failed"),
                },
              },
            ]
          : [
              {
                ...base,
                type: "runtime.warning",
                payload: {
                  message: PRIME_AGENT_FINISHED_WITHOUT_FINAL_RESPONSE,
                  detail: primeAgentMissingFinalResponseDetail("completed"),
                },
              },
            ];
      return [...terminalNotice, completed, ready];
    }

    case "TurnStarted":
      return [];
    case "MessageStarted": {
      const itemId = event.message.role === "assistant" ? assistantItemId(context) : undefined;
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
      const itemId = event.message.role === "assistant" ? assistantItemId(context) : undefined;
      if (itemId === undefined || event.message.role !== "assistant") return [];
      const failed =
        event.message.stopReason === "error" ||
        boundedNonEmpty(event.message.errorMessage) !== undefined;
      const completed: PrimeAgentRuntimeEventDraft = {
        ...base,
        type: "item.completed",
        itemId,
        payload: {
          itemType: "assistant_message",
          status: failed ? "failed" : "completed",
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
        const itemId = assistantItemId(context);
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
        const detail = boundedNonEmpty(event.content, MAX_SCALAR_LENGTH);
        if (itemId === undefined || event.phase !== "end" || detail === undefined) return [];
        return [
          {
            ...base,
            type: "item.completed",
            itemId,
            payload: {
              itemType: "reasoning",
              status: "completed",
              title: "Reasoning",
              detail,
            },
          },
        ];
      }
      return [];
    }
    case "ToolStarted": {
      const draft = toolLifecycleDraft({
        ...context,
        lifecycle: "item.started",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      return draft === undefined ? [] : [draft];
    }
    case "ToolProgress": {
      const draft = toolLifecycleDraft({
        ...context,
        lifecycle: "item.updated",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      return draft === undefined ? [] : [draft];
    }
    case "ToolCompleted": {
      const draft = toolLifecycleDraft({
        ...context,
        lifecycle: "item.completed",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
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
    case "CompactionStarted":
      return [
        {
          ...base,
          type: "item.started",
          itemId: compactionItemId(context),
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            title: "Context compaction",
          },
        },
      ];
    case "CompactionCompleted":
      return [
        {
          ...base,
          type: "item.completed",
          itemId: compactionItemId(context),
          payload: {
            itemType: "context_compaction",
            status:
              event.outcome === "completed"
                ? "completed"
                : event.outcome === "skipped"
                  ? "declined"
                  : "failed",
            title: "Context compaction",
          },
        },
      ];
    case "RetryStarted":
      return [
        {
          ...base,
          type: "item.started",
          itemId: retryItemId(context),
          payload: {
            itemType: "retry",
            status: "inProgress",
            title: "Provider retry",
            data: {
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
            },
          },
        },
      ];
    case "RetryCompleted":
      return [
        {
          ...base,
          type: "item.completed",
          itemId: retryItemId(context),
          payload: {
            itemType: "retry",
            status: event.success ? "completed" : "failed",
            title: "Provider retry",
            data: { attempt: event.attempt },
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
      const partial = event.appliedCount > 0 && event.failedCount > 0;
      return [
        {
          ...base,
          type: "item.completed",
          payload: {
            itemType: "refinement",
            status: event.appliedCount === 0 && event.failedCount > 0 ? "failed" : "completed",
            title: "Harness refinement",
            data: {
              appliedCount: event.appliedCount,
              failedCount: event.failedCount,
              outcome: partial ? "partial" : event.failedCount > 0 ? "failed" : "completed",
            },
          },
        },
      ];
    }
    case "RefinementFailed":
      return [
        {
          ...base,
          type: "item.completed",
          payload: { itemType: "refinement", status: "failed", title: "Harness refinement" },
        },
      ];
    case "ConnectionStatus": {
      const hasError = boundedNonEmpty(event.error, MAX_SCALAR_LENGTH) !== undefined;
      return [
        {
          ...base,
          type: "session.state.changed",
          payload: {
            state: event.status === "connected" ? "ready" : "starting",
            ...(hasError ? { reason: "Prime Agent connection is unavailable." } : {}),
          },
        },
      ];
    }
    case "SessionClosed": {
      const hasError = boundedNonEmpty(event.error) !== undefined;
      return [
        {
          ...base,
          type: "session.exited",
          payload: {
            exitKind: hasError ? "error" : "graceful",
            ...(hasError ? { reason: "Prime Agent session closed unexpectedly." } : {}),
          },
        },
      ];
    }
    case "RlmQuiesced":
    case "AgentMessageSent":
    case "QueueChanged":
    case "ThinkingLevelChanged":
    case "ServiceTierChanged":
    case "RecapUpdated":
    case "GoalUpdated":
    case "BashStarted":
    case "BashOutput":
    case "BashCompleted":
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
