import {
  MessageId,
  NodeId,
  PlanId,
  ProviderTurnId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
  type SessionInteractionRequest,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2ThreadSnapshot,
  ProviderAdapterV2TurnInput,
} from "../../orchestration-v2/ProviderAdapter.ts";

type ItemBase = Omit<
  Extract<OrchestrationV2TurnItem, { type: "reasoning" }>,
  "type" | "text" | "streaming"
>;
type ItemEvent = Extract<
  ProviderRuntimeEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
>;
type RequestRoute = {
  readonly legacyRequestId: RuntimeRequestId;
  readonly kind: "approval" | "user_input" | "interaction";
  readonly interaction?: SessionInteractionRequest;
};

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function decision(value: unknown): ProviderApprovalDecision | undefined {
  return value === "accept" ||
    value === "acceptForSession" ||
    value === "acceptAlways" ||
    value === "decline" ||
    value === "cancel"
    ? value
    : undefined;
}

function answers(value: Readonly<Record<string, unknown>>): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(value).map(([key, answer]) => [
      key,
      typeof answer === "string"
        ? answer
        : Array.isArray(answer)
          ? answer.filter((entry): entry is string => typeof entry === "string")
          : "",
    ]),
  );
}

function requestKind(type: string): OrchestrationV2RuntimeRequest["kind"] {
  switch (type) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    case "tool_user_input":
      return "user_input";
    case "dynamic_tool_call":
      return "dynamic_tool_call";
    case "auth_tokens_refresh":
      return "auth_refresh";
    default:
      return "permission";
  }
}

function providerFailure(
  message: string,
  failureClass: OrchestrationV2ProviderFailure["class"] = "provider_error",
): OrchestrationV2ProviderFailure {
  return {
    class: failureClass,
    message: message.trim().slice(0, 4096) || "The provider turn failed.",
    code: null,
    retryable: null,
  };
}

/**
 * The legacy adapter emits deltas; v2 ingests complete entities. One projector
 * belongs to one opened runtime, so state cannot cross a session incarnation.
 */
export function makeLegacyRuntimeEventProjector(input: {
  readonly providerSession: OrchestrationV2ProviderSession;
  readonly providerThread: OrchestrationV2ProviderThread;
}) {
  let providerSession = input.providerSession;
  let providerThread = input.providerThread;
  let pendingTurn: ProviderAdapterV2TurnInput | undefined;
  let activeTurn: OrchestrationV2ProviderTurn | undefined;
  let nextOrdinal = 1;
  const turns = new Map<TurnId, OrchestrationV2ProviderTurn>();
  const turnInputs = new Map<string, ProviderAdapterV2TurnInput>();
  const items = new Map<TurnItemId, OrchestrationV2TurnItem>();
  const messages = new Map<MessageId, OrchestrationV2ConversationMessage>();
  const requests = new Map<RuntimeRequestId, OrchestrationV2RuntimeRequest>();
  const routes = new Map<RuntimeRequestId, RequestRoute>();
  const subagents = new Map<NodeId, OrchestrationV2Subagent>();
  const plans = new Map<PlanId, OrchestrationV2PlanArtifact>();
  const itemParents = new Map<TurnItemId, NodeId>();
  const seenEvents = new Set<string>();
  const terminals = new Set<ProviderTurnId>();
  let queuedInputs = false;
  let compacting = false;
  let refiningHarness = false;
  let activeGoal = false;
  const driver = providerSession.driver;

  const ref = (nativeId: string | undefined) =>
    nativeId === undefined ? null : { driver, nativeId, strength: "strong" as const };
  const turnFor = (event: ProviderRuntimeEvent) =>
    event.turnId === undefined ? activeTurn : turns.get(event.turnId);
  const contextFor = (turn: OrchestrationV2ProviderTurn | undefined) =>
    turn === undefined ? pendingTurn : turnInputs.get(turn.id);
  const itemIdFor = (event: ProviderRuntimeEvent, suffix = "item") =>
    TurnItemId.make(
      `${providerThread.id}:${event.turnId ?? activeTurn?.id ?? "session"}:${event.itemId ?? suffix}`,
    );
  const itemBase = (event: ProviderRuntimeEvent, suffix?: string): ItemBase => {
    const id = itemIdFor(event, suffix);
    const previous = items.get(id);
    const turn = turnFor(event);
    const context = contextFor(turn);
    const now = DateTime.makeUnsafe(event.createdAt);
    return {
      id,
      threadId: event.threadId,
      runId: context?.runId ?? null,
      nodeId: context === undefined && turn === undefined ? null : NodeId.make(`${id}:node`),
      providerThreadId: providerThread.id,
      providerTurnId: turn?.id ?? null,
      nativeItemRef: ref(event.providerRefs?.providerItemId),
      parentItemId: null,
      ordinal: previous?.ordinal ?? nextOrdinal++,
      status: previous?.status ?? "running",
      title: previous?.title ?? null,
      startedAt: previous?.startedAt ?? now,
      completedAt: previous?.completedAt ?? null,
      updatedAt: now,
    };
  };

  const publishItem = (item: OrchestrationV2TurnItem, output: ProviderAdapterV2Event[]) => {
    items.set(item.id, item);
    const context =
      item.providerTurnId === null ? pendingTurn : turnInputs.get(item.providerTurnId);
    if (item.nodeId !== null && context !== undefined) {
      const kind: OrchestrationV2ExecutionNode["kind"] =
        item.type === "assistant_message"
          ? "assistant_message"
          : item.type === "reasoning"
            ? "reasoning"
            : item.type === "todo_list"
              ? "todo_list"
              : item.type === "proposed_plan"
                ? "plan"
                : item.type === "approval_request"
                  ? "approval_request"
                  : item.type === "user_input_request"
                    ? "user_input_request"
                    : item.type === "subagent"
                      ? "subagent"
                      : item.type === "dynamic_tool" ||
                          item.type === "command_execution" ||
                          item.type === "file_change" ||
                          item.type === "file_search" ||
                          item.type === "web_search"
                        ? "tool_call"
                        : "system";
      output.push({
        type: "node.updated",
        driver,
        node: {
          id: item.nodeId,
          threadId: item.threadId,
          runId: item.runId,
          parentNodeId: itemParents.get(item.id) ?? context.rootNodeId,
          rootNodeId: context.rootNodeId,
          kind,
          status: item.status,
          countsForRun:
            kind === "tool_call" || kind === "approval_request" || kind === "user_input_request",
          providerThreadId: item.providerThreadId ?? null,
          providerTurnId: item.providerTurnId,
          nativeItemRef: item.nativeItemRef,
          runtimeRequestId:
            item.type === "approval_request" || item.type === "user_input_request"
              ? item.requestId
              : null,
          checkpointScopeId: null,
          startedAt: item.startedAt,
          completedAt: item.completedAt,
        },
      });
    }
    output.push({ type: "turn_item.updated", driver, turnItem: item });
    if (item.type !== "assistant_message") return;
    const previous = messages.get(item.messageId);
    const message: OrchestrationV2ConversationMessage = {
      id: item.messageId,
      threadId: item.threadId,
      runId: item.runId,
      nodeId: item.nodeId,
      role: "assistant",
      createdBy: "agent",
      creationSource: "provider",
      text: item.text,
      attachments: item.attachments ?? [],
      streaming: item.streaming,
      createdAt: previous?.createdAt ?? item.startedAt ?? item.updatedAt,
      updatedAt: item.updatedAt,
    };
    messages.set(message.id, message);
    output.push({ type: "message.updated", driver, message });
  };

  const notification = (
    event: ProviderRuntimeEvent,
    message: string,
    output: ProviderAdapterV2Event[],
    status: "completed" | "failed" = "completed",
  ) => {
    // system_notice is v2's nonblocking notification item and does not create
    // an extra persisted conversation message for provider diagnostics.
    publishItem(
      {
        ...itemBase(event, event.eventId),
        type: "system_notice",
        message,
        status,
        completedAt: DateTime.makeUnsafe(event.createdAt),
      },
      output,
    );
  };

  const lifecycleItem = (event: ItemEvent, output: ProviderAdapterV2Event[]) => {
    const base = itemBase(event);
    if (event.payload.agentId !== undefined)
      itemParents.set(base.id, NodeId.make(`${providerThread.id}:task:${event.payload.agentId}`));
    const previous = items.get(base.id);
    const data = record(event.payload.data);
    const status: OrchestrationV2TurnItem["status"] =
      event.payload.status === "failed"
        ? "failed"
        : event.payload.status === "declined"
          ? "cancelled"
          : event.type === "item.completed" || event.payload.status === "completed"
            ? "completed"
            : "running";
    const common = {
      ...base,
      status,
      title: event.payload.title ?? base.title,
      completedAt: status === "running" ? null : base.updatedAt,
      ...(event.payload.toolSurface === undefined
        ? {}
        : { toolSurface: event.payload.toolSurface }),
      ...(event.payload.toolIcon === undefined ? {} : { toolIcon: event.payload.toolIcon }),
      ...(event.payload.toolSource === undefined ? {} : { toolSource: event.payload.toolSource }),
    };
    switch (event.payload.itemType) {
      case "assistant_message":
        publishItem(
          {
            ...common,
            type: "assistant_message",
            messageId:
              previous?.type === "assistant_message"
                ? previous.messageId
                : MessageId.make(`${base.id}:message`),
            text:
              text(data.text) ??
              (previous?.type === "assistant_message"
                ? previous.text
                : (event.payload.detail ?? "")),
            streaming: status === "running",
          },
          output,
        );
        break;
      case "reasoning":
        publishItem(
          {
            ...common,
            type: "reasoning",
            text:
              text(data.text) ??
              event.payload.detail ??
              (previous?.type === "reasoning" ? previous.text : ""),
            streaming: status === "running",
          },
          output,
        );
        break;
      case "command_execution": {
        const command = previous?.type === "command_execution" ? previous : undefined;
        const exitCode =
          typeof data.exitCode === "number" && Number.isSafeInteger(data.exitCode)
            ? data.exitCode
            : command?.exitCode;
        publishItem(
          {
            ...common,
            type: "command_execution",
            input:
              text(data.command) ??
              text(data.input) ??
              command?.input ??
              event.payload.title ??
              "Command",
            ...((text(data.output) ?? command?.output ?? event.payload.detail) === undefined
              ? {}
              : { output: text(data.output) ?? command?.output ?? event.payload.detail }),
            ...(exitCode === undefined ? {} : { exitCode }),
          },
          output,
        );
        break;
      }
      case "file_change": {
        const file = previous?.type === "file_change" ? previous : undefined;
        const additions = nonNegativeNumber(data.additions) ?? file?.additions;
        const deletions = nonNegativeNumber(data.deletions) ?? file?.deletions;
        const diffStr = text(data.diff) ?? text(data.diffStr) ?? file?.diffStr;
        publishItem(
          {
            ...common,
            type: "file_change",
            fileName:
              text(data.path) ??
              text(data.fileName) ??
              file?.fileName ??
              event.payload.title ??
              "File change",
            ...(additions === undefined ? {} : { additions }),
            ...(deletions === undefined ? {} : { deletions }),
            ...(diffStr === undefined ? {} : { diffStr }),
          },
          output,
        );
        break;
      }
      case "context_compaction":
        publishItem(
          {
            ...common,
            type: "compaction",
            driver,
            ...(event.payload.detail === undefined ? {} : { summary: event.payload.detail }),
          },
          output,
        );
        break;
      case "error":
        publishItem(
          {
            ...common,
            type: "error",
            failure: providerFailure(
              event.payload.detail ?? event.payload.title ?? "Provider item failed.",
            ),
          },
          output,
        );
        break;
      case "web_search":
        publishItem(
          {
            ...common,
            type: "web_search",
            ...(text(data.query) === undefined ? {} : { patterns: [text(data.query)!] }),
          },
          output,
        );
        break;
      case "user_message":
        // The v2 command owns user messages and their admission identity.
        break;
      default:
        publishItem(
          {
            ...common,
            type: "dynamic_tool",
            toolName: text(data.toolName) ?? event.payload.title ?? null,
            input: data.input ?? null,
            ...(data.output === undefined && event.payload.detail === undefined
              ? {}
              : { output: data.output ?? event.payload.detail }),
          },
          output,
        );
    }
  };

  const project = (event: ProviderRuntimeEvent): ReadonlyArray<ProviderAdapterV2Event> => {
    if (
      event.threadId !== providerThread.appThreadId ||
      event.provider !== driver ||
      (event.providerInstanceId !== undefined &&
        event.providerInstanceId !== providerSession.providerInstanceId) ||
      seenEvents.has(event.eventId)
    )
      return [];
    seenEvents.add(event.eventId);
    const output: ProviderAdapterV2Event[] = [];
    const now = DateTime.makeUnsafe(event.createdAt);
    const sessionUpdate = (patch: Partial<OrchestrationV2ProviderSession>) => {
      providerSession = { ...providerSession, ...patch, updatedAt: now };
      output.push({ type: "provider_session.updated", driver, providerSession });
    };
    const threadUpdate = (patch: Partial<OrchestrationV2ProviderThread>) => {
      providerThread = { ...providerThread, ...patch, updatedAt: now };
      output.push({ type: "provider_thread.updated", driver, providerThread });
    };
    const turn = turnFor(event);
    const context = contextFor(turn);
    switch (event.type) {
      case "session.started":
        sessionUpdate({ status: "ready" });
        break;
      case "session.configured": {
        const config = event.payload.config;
        sessionUpdate({
          model: text(config.model) ?? providerSession.model,
          cwd: text(config.cwd) ?? providerSession.cwd,
        });
        break;
      }
      case "session.state.changed":
        sessionUpdate({
          status: event.payload.state,
          lastError:
            event.payload.state === "error"
              ? (event.payload.reason ?? "The provider session failed.")
              : null,
        });
        break;
      case "session.exited":
        sessionUpdate({
          status: event.payload.exitKind === "error" ? "error" : "stopped",
          lastError:
            event.payload.exitKind === "error"
              ? (event.payload.reason ?? "The provider session exited.")
              : null,
        });
        break;
      case "thread.started":
        threadUpdate({ nativeThreadRef: ref(event.payload.providerThreadId), status: "idle" });
        break;
      case "thread.state.changed": {
        threadUpdate({
          status: event.payload.state === "compacted" ? "idle" : event.payload.state,
        });
        if (event.payload.state === "compacted")
          publishItem(
            {
              ...itemBase(event, event.eventId),
              type: "compaction",
              driver,
              status: "completed",
              completedAt: now,
              ...(event.payload.beforeTokens === undefined
                ? {}
                : { beforeTokenCount: event.payload.beforeTokens }),
              ...(event.payload.afterTokens === undefined
                ? {}
                : { afterTokenCount: event.payload.afterTokens }),
            },
            output,
          );
        break;
      }
      case "thread.metadata.updated":
        threadUpdate({
          nativeMetadata: {
            ...providerThread.nativeMetadata,
            ...(event.payload.name === undefined ? {} : { name: event.payload.name }),
          },
        });
        break;
      case "thread.token-usage.updated": {
        threadUpdate({ contextUsage: event.payload.usage });
        if (turn !== undefined) {
          const updated = {
            ...turn,
            tokenUsage: { ...event.payload.usage, updatedAt: event.createdAt },
          };
          if (event.turnId !== undefined) turns.set(event.turnId, updated);
          if (activeTurn?.id === turn.id) activeTurn = updated;
          output.push({
            type: "provider_turn.updated",
            driver,
            threadId: event.threadId,
            providerTurn: updated,
          });
        }
        break;
      }
      case "thread.token-usage.cleared":
        threadUpdate({ contextUsage: null });
        break;
      case "turn.started": {
        if (event.turnId === undefined || context === undefined) break;
        const previous = turns.get(event.turnId);
        activeTurn = previous ?? {
          id: ProviderTurnId.make(`${providerThread.id}:${event.turnId}`),
          providerThreadId: providerThread.id,
          nodeId: context.rootNodeId,
          runAttemptId: context.attemptId,
          nativeTurnRef: ref(event.providerRefs?.providerTurnId ?? event.turnId),
          ordinal: context.providerTurnOrdinal,
          status: "running",
          startedAt: now,
          completedAt: null,
        };
        turns.set(event.turnId, activeTurn);
        turnInputs.set(activeTurn.id, context);
        pendingTurn = undefined;
        threadUpdate({
          status: "active",
          ownerNodeId: context.rootNodeId,
          firstRunOrdinal: providerThread.firstRunOrdinal ?? context.runOrdinal,
          lastRunOrdinal: context.runOrdinal,
        });
        output.push({
          type: "provider_turn.updated",
          driver,
          threadId: event.threadId,
          providerTurn: activeTurn,
        });
        break;
      }
      case "turn.completed":
      case "turn.aborted": {
        if (turn === undefined || context === undefined || terminals.has(turn.id)) break;
        const status = event.type === "turn.aborted" ? "interrupted" : event.payload.state;
        const updated: OrchestrationV2ProviderTurn = {
          ...turn,
          status,
          completedAt: now,
          ...(event.payload.tokenUsage === undefined
            ? {}
            : { turnTokenUsage: event.payload.tokenUsage }),
        };
        if (event.turnId !== undefined) turns.set(event.turnId, updated);
        activeTurn = updated;
        for (const item of items.values()) {
          if (
            item.providerTurnId !== turn.id ||
            (item.status !== "running" && item.status !== "waiting" && item.status !== "pending")
          )
            continue;
          publishItem(
            {
              ...item,
              status,
              completedAt: now,
              updatedAt: now,
              ...("streaming" in item ? { streaming: false } : {}),
            },
            output,
          );
        }
        for (const [id, request] of requests) {
          if (request.providerTurnId !== turn.id || request.status !== "pending") continue;
          const resolved = { ...request, status: "expired" as const, resolvedAt: now };
          requests.set(id, resolved);
          output.push({
            type: "runtime_request.updated",
            driver,
            threadId: event.threadId,
            runtimeRequest: resolved,
          });
        }
        output.push({
          type: "provider_turn.updated",
          driver,
          threadId: event.threadId,
          providerTurn: updated,
        });
        threadUpdate({ status: "idle" });
        if (status === "failed") {
          const failure = providerFailure(
            event.type === "turn.completed"
              ? (event.payload.errorMessage ??
                  event.payload.stopReason ??
                  "The provider turn failed.")
              : event.payload.reason,
          );
          const failureItem = {
            ...itemBase(event, `${turn.id}:failure`),
            type: "error" as const,
            status: "failed" as const,
            failure,
            completedAt: now,
          };
          publishItem(failureItem, output);
          output.push({
            type: "turn.terminal",
            driver,
            providerThreadId: providerThread.id,
            providerTurnId: turn.id,
            runOrdinal: context.runOrdinal,
            failureItemOrdinal: failureItem.ordinal,
            status,
            failure,
            threadDisposition: "reusable",
          });
        } else
          output.push({
            type: "turn.terminal",
            driver,
            providerThreadId: providerThread.id,
            providerTurnId: turn.id,
            runOrdinal: context.runOrdinal,
            status,
            failure: null,
            threadDisposition: "reusable",
          });
        terminals.add(turn.id);
        break;
      }
      case "content.delta": {
        const base = itemBase(event, event.payload.streamKind);
        const previous = items.get(base.id);
        if (event.payload.streamKind === "assistant_text")
          publishItem(
            {
              ...base,
              type: "assistant_message",
              messageId:
                previous?.type === "assistant_message"
                  ? previous.messageId
                  : MessageId.make(`${base.id}:message`),
              text:
                (previous?.type === "assistant_message" ? previous.text : "") + event.payload.delta,
              streaming: true,
            },
            output,
          );
        else if (
          event.payload.streamKind === "reasoning_text" ||
          event.payload.streamKind === "reasoning_summary_text"
        )
          publishItem(
            {
              ...base,
              type: "reasoning",
              text: (previous?.type === "reasoning" ? previous.text : "") + event.payload.delta,
              streaming: true,
            },
            output,
          );
        else if (
          event.payload.streamKind === "command_output" &&
          previous?.type === "command_execution"
        )
          publishItem(
            { ...previous, output: (previous.output ?? "") + event.payload.delta, updatedAt: now },
            output,
          );
        else if (
          event.payload.streamKind === "file_change_output" &&
          previous?.type === "file_change"
        )
          publishItem(
            {
              ...previous,
              diffStr: (previous.diffStr ?? "") + event.payload.delta,
              updatedAt: now,
            },
            output,
          );
        break;
      }
      case "item.started":
      case "item.updated":
      case "item.completed":
        lifecycleItem(event, output);
        break;
      case "request.opened":
      case "user-input.requested":
      case "interaction.requested": {
        if (event.requestId === undefined || (turn?.nodeId ?? context?.rootNodeId) === undefined)
          break;
        const id = RuntimeRequestId.make(`${providerThread.id}:${event.requestId}`);
        const kind =
          event.type === "request.opened" ? requestKind(event.payload.requestType) : "user_input";
        const base = { ...itemBase(event, event.requestId), status: "waiting" as const };
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id,
          nodeId: base.nodeId ?? context!.rootNodeId,
          providerTurnId: turn?.id ?? null,
          nativeRequestRef: ref(event.providerRefs?.providerRequestId ?? event.requestId),
          kind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: providerSession.id },
          createdAt: now,
          resolvedAt: null,
        };
        routes.set(id, {
          legacyRequestId: event.requestId,
          kind:
            event.type === "request.opened"
              ? "approval"
              : event.type === "user-input.requested"
                ? "user_input"
                : "interaction",
          ...(event.type === "interaction.requested" ? { interaction: event.payload.request } : {}),
        });
        requests.set(id, runtimeRequest);
        output.push({
          type: "runtime_request.updated",
          driver,
          threadId: event.threadId,
          runtimeRequest,
        });
        if (event.type === "user-input.requested")
          publishItem(
            {
              ...base,
              type: "user_input_request",
              requestId: id,
              questions: event.payload.questions.map((question) => ({
                ...question,
                options: question.options.map((option) => ({
                  ...option,
                  description: option.description || option.label,
                })),
              })),
              ...(event.payload.responseMode === undefined
                ? {}
                : { responseMode: event.payload.responseMode }),
            },
            output,
          );
        else if (event.type === "interaction.requested") {
          const request = event.payload.request;
          const options =
            request.kind === "select"
              ? request.options
              : request.kind === "confirm"
                ? ["Confirm", "Decline"]
                : [];
          publishItem(
            {
              ...base,
              type: "user_input_request",
              requestId: id,
              questions: [
                {
                  id: "interaction",
                  header: request.title,
                  question:
                    request.kind === "confirm" ? request.message || request.title : request.title,
                  options: options.map((option) => ({ label: option, description: option })),
                  allowCustomAnswer: request.kind === "input" || request.kind === "editor",
                  multiSelect: false,
                },
              ],
            },
            output,
          );
        } else if (kind !== "user_input" && kind !== "dynamic_tool_call" && kind !== "auth_refresh")
          publishItem(
            {
              ...base,
              type: "approval_request",
              requestId: id,
              requestKind: kind,
              ...(event.payload.detail === undefined ? {} : { prompt: event.payload.detail }),
              ...(event.payload.appName === undefined ? {} : { appName: event.payload.appName }),
              ...(event.payload.options === undefined ? {} : { options: event.payload.options }),
            },
            output,
          );
        break;
      }
      case "request.resolved":
      case "user-input.resolved":
      case "interaction.resolved": {
        if (event.requestId === undefined) break;
        const id = RuntimeRequestId.make(`${providerThread.id}:${event.requestId}`);
        const previous = requests.get(id);
        if (previous === undefined) break;
        const selectedDecision =
          event.type === "request.resolved" ? decision(event.payload.decision) : undefined;
        const resolved: OrchestrationV2RuntimeRequest = {
          ...previous,
          status:
            event.type === "interaction.resolved" && event.payload.response.kind === "cancelled"
              ? "cancelled"
              : "resolved",
          resolvedAt: now,
          ...(selectedDecision === undefined ? {} : { decision: selectedDecision }),
          ...(event.type === "user-input.resolved"
            ? { answers: answers(event.payload.answers) }
            : {}),
        };
        requests.set(id, resolved);
        output.push({
          type: "runtime_request.updated",
          driver,
          threadId: event.threadId,
          runtimeRequest: resolved,
        });
        for (const item of items.values())
          if (
            (item.type === "approval_request" || item.type === "user_input_request") &&
            item.requestId === id
          )
            publishItem({ ...item, status: "completed", completedAt: now, updatedAt: now }, output);
        break;
      }
      case "task.started":
      case "task.progress":
      case "task.updated":
      case "task.completed": {
        const parentNodeId =
          event.payload.parentAgentId === undefined
            ? (turn?.nodeId ?? context?.rootNodeId)
            : NodeId.make(`${providerThread.id}:task:${event.payload.parentAgentId}`);
        if (parentNodeId === undefined) break;
        const id = NodeId.make(`${providerThread.id}:task:${event.payload.taskId}`);
        const previous = subagents.get(id);
        const status =
          event.type === "task.completed"
            ? event.payload.status === "stopped"
              ? "cancelled"
              : event.payload.status
            : event.type === "task.started"
              ? "running"
              : (event.payload.status ?? previous?.status ?? "running");
        const terminal =
          status === "completed" ||
          status === "failed" ||
          status === "cancelled" ||
          status === "interrupted";
        const agent: OrchestrationV2Subagent = {
          id,
          threadId: event.threadId,
          runId: context?.runId ?? previous?.runId ?? null,
          parentNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId: providerSession.providerInstanceId,
          providerThreadId: providerThread.id,
          childThreadId: null,
          nativeTaskRef: ref(event.payload.taskId),
          prompt:
            previous?.prompt ??
            ("description" in event.payload ? event.payload.description : undefined) ??
            "Provider task",
          title: event.payload.title ?? previous?.title ?? null,
          model: event.payload.model ?? previous?.model ?? null,
          status,
          ...(event.type === "task.progress"
            ? { progress: event.payload.summary ?? event.payload.description }
            : previous?.progress === undefined
              ? {}
              : { progress: previous.progress }),
          result:
            event.type === "task.completed"
              ? (event.payload.summary ?? null)
              : (previous?.result ?? null),
          startedAt: previous?.startedAt ?? now,
          completedAt: terminal ? now : null,
          updatedAt: now,
        };
        subagents.set(id, agent);
        output.push({ type: "subagent.updated", driver, subagent: agent });
        const base = itemBase(event, `task:${event.payload.taskId}`);
        itemParents.set(base.id, parentNodeId);
        publishItem(
          {
            ...base,
            nodeId: id,
            type: "subagent",
            subagentId: id,
            origin: "provider_native",
            driver,
            providerInstanceId: providerSession.providerInstanceId,
            childThreadId: null,
            prompt: agent.prompt,
            title: agent.title,
            status,
            result: agent.result,
            ...(agent.progress === undefined ? {} : { progress: agent.progress }),
            completedAt: agent.completedAt,
          },
          output,
        );
        break;
      }
      case "turn.plan.updated": {
        const base = itemBase(event, "todo");
        const nodeId = base.nodeId;
        if (nodeId === null) break;
        const id = PlanId.make(`${providerThread.id}:${turn?.id ?? "session"}:todo`);
        const steps = event.payload.plan.map((step, index) => ({
          id: `${id}:${index}`,
          text: step.step,
          status:
            step.status === "inProgress" || step.status === "waiting"
              ? ("running" as const)
              : step.status,
        }));
        const plan: OrchestrationV2PlanArtifact = {
          id,
          threadId: event.threadId,
          runId: context?.runId ?? null,
          nodeId,
          status:
            steps.length > 0 && steps.every((step) => step.status === "completed")
              ? "completed"
              : "active",
          kind: "todo_list",
          steps,
          ...(event.payload.explanation == null ? {} : { explanation: event.payload.explanation }),
        };
        plans.set(id, plan);
        output.push({ type: "plan.updated", driver, plan });
        publishItem(
          {
            ...base,
            type: "todo_list",
            planId: id,
            steps,
            ...(event.payload.explanation == null
              ? {}
              : { explanation: event.payload.explanation }),
            status: plan.status === "completed" ? "completed" : "running",
            completedAt: plan.status === "completed" ? now : null,
          },
          output,
        );
        break;
      }
      case "turn.proposed.delta":
      case "turn.proposed.completed": {
        const base = itemBase(event, "proposed");
        const nodeId = base.nodeId;
        if (nodeId === null) break;
        const id = PlanId.make(`${providerThread.id}:${turn?.id ?? "session"}:proposed`);
        const previous = plans.get(id);
        const markdown =
          event.type === "turn.proposed.completed"
            ? event.payload.planMarkdown
            : (previous?.kind === "proposed_plan" ? previous.markdown : "") + event.payload.delta;
        const plan: OrchestrationV2PlanArtifact = {
          id,
          threadId: event.threadId,
          runId: context?.runId ?? null,
          nodeId,
          status: "draft",
          kind: "proposed_plan",
          markdown,
        };
        plans.set(id, plan);
        output.push({ type: "plan.updated", driver, plan });
        publishItem(
          {
            ...base,
            type: "proposed_plan",
            planId: id,
            markdown,
            streaming: event.type === "turn.proposed.delta",
            status: event.type === "turn.proposed.delta" ? "running" : "completed",
            completedAt: event.type === "turn.proposed.completed" ? now : null,
          },
          output,
        );
        break;
      }
      case "runtime.warning":
        notification(event, event.payload.message, output);
        break;
      case "runtime.error":
        notification(event, event.payload.message, output, "failed");
        break;
      case "tool.denied":
        notification(
          event,
          `${event.payload.toolName} was denied${event.payload.reason === undefined ? "." : `: ${event.payload.reason}`}`,
          output,
          "failed",
        );
        break;
      case "model.rerouted":
        notification(
          event,
          `Model changed from ${event.payload.fromModel} to ${event.payload.toModel}: ${event.payload.reason}`,
          output,
        );
        break;
      case "session-presentation.updated":
        if (event.payload.presentation.kind === "notification")
          notification(
            event,
            event.payload.presentation.message,
            output,
            event.payload.presentation.level === "error" ? "failed" : "completed",
          );
        break;
      case "session.input-queue.updated":
        queuedInputs = event.payload.steeringCount > 0 || event.payload.followUpCount > 0;
        break;
      case "session.compaction.updated":
        compacting = event.payload.status !== "idle";
        break;
      case "session.harness-refinement.updated":
        refiningHarness = event.payload.status === "running";
        break;
      case "session.goal.updated":
        activeGoal = event.payload.active;
        break;
      default:
        // Native diagnostics and session-only controls have no v2 entity.
        // The initial bridge's unsupported vocabulary is recorded in the plan.
        break;
    }
    return output;
  };

  return {
    project,
    prepareTurn: (turnInput: ProviderAdapterV2TurnInput) => {
      pendingTurn = turnInput;
    },
    getProviderSession: () => providerSession,
    getProviderThread: () => providerThread,
    setProviderThread: (thread: OrchestrationV2ProviderThread) => {
      providerThread = thread;
    },
    getLegacyTurnId: (id: ProviderTurnId) =>
      Array.from(turns).find(([, turn]) => turn.id === id)?.[0],
    getRequestRoute: (id: RuntimeRequestId) => routes.get(id),
    getRuntimeRequest: (id: RuntimeRequestId) => requests.get(id),
    rollbackThroughOrdinal: (ordinal: number) => {
      const removedTurnIds = new Set<ProviderTurnId>();
      const removedRunIds = new Set<string>();
      for (const [legacyId, turn] of turns) {
        if (turn.ordinal <= ordinal) continue;
        removedTurnIds.add(turn.id);
        const context = turnInputs.get(turn.id);
        if (context !== undefined) removedRunIds.add(context.runId);
        turns.delete(legacyId);
        turnInputs.delete(turn.id);
        terminals.delete(turn.id);
      }
      for (const [id, item] of items)
        if (item.providerTurnId !== null && removedTurnIds.has(item.providerTurnId))
          items.delete(id);
      for (const [id, message] of messages)
        if (message.runId !== null && removedRunIds.has(message.runId)) messages.delete(id);
      for (const [id, request] of requests)
        if (request.providerTurnId !== null && removedTurnIds.has(request.providerTurnId)) {
          requests.delete(id);
          routes.delete(id);
        }
      for (const [id, agent] of subagents)
        if (agent.runId !== null && removedRunIds.has(agent.runId)) subagents.delete(id);
      for (const [id, plan] of plans)
        if (plan.runId !== null && removedRunIds.has(plan.runId)) plans.delete(id);
      activeTurn = Array.from(turns.values()).at(-1);
      const context = activeTurn === undefined ? undefined : turnInputs.get(activeTurn.id);
      providerThread = {
        ...providerThread,
        status: "idle",
        lastRunOrdinal: context?.runOrdinal ?? null,
        ...(activeTurn === undefined ? { firstRunOrdinal: null } : {}),
      };
    },
    hasPendingBackgroundWork: () =>
      providerSession.status !== "stopped" &&
      providerSession.status !== "error" &&
      (queuedInputs ||
        compacting ||
        refiningHarness ||
        activeGoal ||
        Array.from(subagents.values()).some(
          (agent) =>
            agent.status === "running" || agent.status === "waiting" || agent.status === "pending",
        )),
    snapshot: (): ProviderAdapterV2ThreadSnapshot => ({
      providerThread,
      providerTurns: Array.from(turns.values()),
      messages: Array.from(messages.values()),
      runtimeRequests: Array.from(requests.values()),
    }),
  };
}
