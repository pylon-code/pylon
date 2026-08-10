/**
 * Pure mapping from Jcode SDK events to canonical provider runtime events.
 *
 * Everything Jcode-native stops here. The session runtime feeds one `ApiEvent`
 * plus a stamp into `mapJcodeRuntimeEvent` and gets back complete
 * `ProviderRuntimeEvent` values; no wire schema, client state, or
 * provider-specific contract is introduced by this file.
 *
 * Three rules shape the mapping:
 *
 *   - **Nothing native reaches a client-visible field.** Native call and task
 *     IDs become opaque `jcode-tool:` / `jcode-task:` handles, and the native
 *     session ID is never copied anywhere. A permission request's `request_id`
 *     is dropped outright rather than echoed as a correlation handle.
 *   - **Every string is bounded before it enters a payload.** Jcode streams
 *     unbounded tool output and status text, and a projection is a durable
 *     store: an unbounded copy is a persistent memory fault, not a display bug.
 *   - **State is immutable and bounded.** The adapter carries only what
 *     multi-event lifecycles require, and both per-call and per-task tracking
 *     have hard caps so a hostile or looping harness cannot grow it forever.
 *
 * `raw` is never set: it would carry native identity straight back into the
 * diagnostic envelope this mapper exists to strip.
 */
import type { ApiEvent } from "@1jehuang/jcode-sdk";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeTaskId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
  type ToolLifecycleItemType,
  type TurnId,
} from "@t3tools/contracts";

const JCODE_PROVIDER = ProviderDriverKind.make("jcode");

/** Streamed assistant text and tool output; matches the canonical text bound. */
const MAX_TEXT_LENGTH = 100_000;
/** Titles, descriptions, summaries, and any scalar echoed from the harness. */
const MAX_SCALAR_LENGTH = 4_000;
/** Accumulated tool-call input retained for JSON completion detection. */
const MAX_TOOL_INPUT_LENGTH = 8_000;
/** Concurrent tool calls and background tasks tracked per session. */
const MAX_TRACKED_TOOL_CALLS = 64;
const MAX_TRACKED_TASKS = 64;

export interface JcodeEventMappingContext {
  readonly eventId: EventId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly createdAt: string;
}

/**
 * Adapter-local state for lifecycles that span several SDK events.
 *
 * `toolNames` is kept beside `toolInputs` rather than folded into it: the
 * canonical item type of a `tool_input_delta` is derived from the tool name
 * announced by the earlier `tool_start`, and `tool_input_delta` itself carries
 * no name. Storing both in one value would make the accumulated-input bound
 * (which drives JSON completion detection) depend on the tool name's length.
 */
export interface JcodeEventMappingState {
  readonly assistantStarted: boolean;
  readonly reasoningStarted: boolean;
  readonly toolInputs: ReadonlyMap<string, string>;
  readonly toolNames: ReadonlyMap<string, string>;
  readonly startedTasks: ReadonlySet<string>;
  readonly currentModel?: string;
}

export interface JcodeEventMappingResult {
  readonly state: JcodeEventMappingState;
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  /** True when the invariant this event broke makes the turn unrecoverable. */
  readonly fatal: boolean;
}

export const initialJcodeEventMappingState: JcodeEventMappingState = {
  assistantStarted: false,
  reasoningStarted: false,
  toolInputs: new Map(),
  toolNames: new Map(),
  startedTasks: new Set(),
};

type RuntimeEventDraft<Event> = Event extends ProviderRuntimeEvent ? Omit<Event, "eventId"> : never;
type JcodeRuntimeEventDraft = RuntimeEventDraft<ProviderRuntimeEvent>;

function bounded(value: string, maximum = MAX_TEXT_LENGTH): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function boundedNonEmpty(value: string | undefined, maximum = MAX_TEXT_LENGTH): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return bounded(value, maximum);
}

/** Opaque, deterministic, and reversible only inside this server process. */
function opaqueId(prefix: string, nativeId: string): string {
  return `${prefix}:${Buffer.from(nativeId, "utf8").toString("base64url")}`;
}

function toolItemId(callId: string): RuntimeItemId {
  return RuntimeItemId.make(opaqueId("jcode-tool", callId));
}

function taskId(nativeTaskId: string): RuntimeTaskId {
  return RuntimeTaskId.make(opaqueId("jcode-task", nativeTaskId));
}

/**
 * Assistant and reasoning items are keyed by the Pylon turn (thread when the
 * mapper runs outside a turn), never by anything the harness supplied.
 */
function assistantItemId(context: JcodeEventMappingContext): RuntimeItemId {
  return RuntimeItemId.make(`jcode-assistant:${context.turnId ?? context.threadId}`);
}

function reasoningItemId(context: JcodeEventMappingContext): RuntimeItemId {
  return RuntimeItemId.make(`jcode-reasoning:${context.turnId ?? context.threadId}`);
}

function base(context: JcodeEventMappingContext) {
  return {
    provider: JCODE_PROVIDER,
    providerInstanceId: context.providerInstanceId,
    threadId: context.threadId,
    createdAt: context.createdAt,
    ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
  };
}

/**
 * One SDK event can produce several canonical events, and ingestion keys
 * activities by `eventId`, so each emitted event gets its own suffix off the
 * caller's stamp rather than sharing it.
 */
function stamp(
  drafts: ReadonlyArray<JcodeRuntimeEventDraft>,
  context: JcodeEventMappingContext,
): ReadonlyArray<ProviderRuntimeEvent> {
  return drafts.map(
    (draft, index) =>
      ({
        ...draft,
        eventId: EventId.make(`${context.eventId}:${index + 1}`),
      }) as ProviderRuntimeEvent,
  );
}

function result(
  state: JcodeEventMappingState,
  drafts: ReadonlyArray<JcodeRuntimeEventDraft>,
  context: JcodeEventMappingContext,
  fatal = false,
): JcodeEventMappingResult {
  return { state, events: stamp(drafts, context), fatal };
}

function ignored(state: JcodeEventMappingState): JcodeEventMappingResult {
  return { state, events: [], fatal: false };
}

/** Newest-wins insertion with a hard cap, so tracking cannot grow unbounded. */
function withCappedEntry<Value>(
  map: ReadonlyMap<string, Value>,
  key: string,
  value: Value,
  maximum: number,
): ReadonlyMap<string, Value> {
  const next = new Map(map);
  next.delete(key);
  next.set(key, value);
  while (next.size > maximum) {
    const oldest = next.keys().next();
    if (oldest.done === true) break;
    next.delete(oldest.value);
  }
  return next;
}

function withoutEntry<Value>(
  map: ReadonlyMap<string, Value>,
  key: string,
): ReadonlyMap<string, Value> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

function nameTokens(toolName: string): ReadonlyArray<string> {
  return toolName
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function canonicalToolItemType(toolName: string): ToolLifecycleItemType {
  const tokens = nameTokens(toolName);
  if (tokens[0] === "mcp") return "mcp_tool_call";
  if (tokens.some((token) => token === "bash" || token === "shell" || token === "ipython")) {
    return "command_execution";
  }
  if (
    tokens.some(
      (token) =>
        token === "edit" || token === "write" || token === "patch" || token === "applypatch",
    )
  ) {
    return "file_change";
  }
  if (tokens.includes("search") && (tokens.includes("web") || tokens.includes("fetch"))) {
    return "web_search";
  }
  return "dynamic_tool_call";
}

function toolItemTypeFor(state: JcodeEventMappingState, callId: string): ToolLifecycleItemType {
  const name = state.toolNames.get(callId);
  return name === undefined ? "dynamic_tool_call" : canonicalToolItemType(name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tool input arrives as JSON fragments. Parsing is attempted only on the whole
 * accumulated value, so a half-received object is surfaced as opaque text
 * rather than guessed at.
 */
function toolInputData(accumulated: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(accumulated);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // Not yet a complete value; fall through to the bounded text form.
  }
  return { input: accumulated };
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const THREAD_STATE_BY_STATUS: ReadonlyMap<string, "active" | "idle" | "error"> = new Map([
  ["idle", "idle"],
  ["ready", "idle"],
  ["done", "idle"],
  ["running", "active"],
  ["busy", "active"],
  ["thinking", "active"],
  ["streaming", "active"],
  ["waiting", "active"],
  ["starting", "active"],
  ["compacting", "active"],
  ["error", "error"],
  ["failed", "error"],
]);

/** Completions synthesized for whatever was still open when the turn ended. */
function closeOpenItems(
  state: JcodeEventMappingState,
  context: JcodeEventMappingContext,
): ReadonlyArray<JcodeRuntimeEventDraft> {
  const drafts: JcodeRuntimeEventDraft[] = [];
  if (state.assistantStarted) {
    drafts.push({
      ...base(context),
      type: "item.completed",
      itemId: assistantItemId(context),
      payload: { itemType: "assistant_message", status: "completed" },
    });
  }
  if (state.reasoningStarted) {
    drafts.push({
      ...base(context),
      type: "item.completed",
      itemId: reasoningItemId(context),
      payload: { itemType: "reasoning", status: "completed", title: "Reasoning" },
    });
  }
  for (const callId of state.toolNames.keys()) {
    drafts.push({
      ...base(context),
      type: "item.completed",
      itemId: toolItemId(callId),
      payload: {
        itemType: toolItemTypeFor(state, callId),
        status: "failed",
        detail: "The tool call did not report completion before the turn ended.",
      },
    });
  }
  return drafts;
}

/**
 * Maps one Jcode SDK event into canonical runtime events.
 *
 * Pure: the supplied state is never mutated, and unknown or request-scoped
 * frames return the identical state object so callers can cheaply detect that
 * nothing happened.
 */
export function mapJcodeRuntimeEvent(
  state: JcodeEventMappingState,
  event: ApiEvent,
  context: JcodeEventMappingContext,
): JcodeEventMappingResult {
  switch (event.ev) {
    case "text_delta": {
      const delta = bounded(event.text);
      const drafts: JcodeRuntimeEventDraft[] = [];
      if (!state.assistantStarted) {
        drafts.push({
          ...base(context),
          type: "item.started",
          itemId: assistantItemId(context),
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
      }
      drafts.push({
        ...base(context),
        type: "content.delta",
        itemId: assistantItemId(context),
        payload: { streamKind: "assistant_text", delta },
      });
      return result({ ...state, assistantStarted: true }, drafts, context);
    }

    case "reasoning_delta": {
      const delta = bounded(event.text);
      const drafts: JcodeRuntimeEventDraft[] = [];
      if (!state.reasoningStarted) {
        drafts.push({
          ...base(context),
          type: "item.started",
          itemId: reasoningItemId(context),
          payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" },
        });
      }
      drafts.push({
        ...base(context),
        type: "content.delta",
        itemId: reasoningItemId(context),
        payload: { streamKind: "reasoning_text", delta },
      });
      return result({ ...state, reasoningStarted: true }, drafts, context);
    }

    case "reasoning_done": {
      if (!state.reasoningStarted) return ignored(state);
      return result(
        { ...state, reasoningStarted: false },
        [
          {
            ...base(context),
            type: "item.completed",
            itemId: reasoningItemId(context),
            payload: { itemType: "reasoning", status: "completed", title: "Reasoning" },
          },
        ],
        context,
      );
    }

    case "tool_start": {
      const title = boundedNonEmpty(event.name, MAX_SCALAR_LENGTH);
      return result(
        {
          ...state,
          toolNames: withCappedEntry(
            state.toolNames,
            event.call_id,
            bounded(event.name, MAX_SCALAR_LENGTH),
            MAX_TRACKED_TOOL_CALLS,
          ),
          toolInputs: withCappedEntry(state.toolInputs, event.call_id, "", MAX_TRACKED_TOOL_CALLS),
        },
        [
          {
            ...base(context),
            type: "item.started",
            itemId: toolItemId(event.call_id),
            payload: {
              itemType: canonicalToolItemType(event.name),
              status: "inProgress",
              ...(title === undefined ? {} : { title }),
            },
          },
        ],
        context,
      );
    }

    case "tool_input_delta": {
      const accumulated = bounded(
        `${state.toolInputs.get(event.call_id) ?? ""}${event.delta}`,
        MAX_TOOL_INPUT_LENGTH,
      );
      const title = boundedNonEmpty(state.toolNames.get(event.call_id), MAX_SCALAR_LENGTH);
      return result(
        {
          ...state,
          toolInputs: withCappedEntry(
            state.toolInputs,
            event.call_id,
            accumulated,
            MAX_TRACKED_TOOL_CALLS,
          ),
        },
        [
          {
            ...base(context),
            type: "item.updated",
            itemId: toolItemId(event.call_id),
            payload: {
              itemType: toolItemTypeFor(state, event.call_id),
              status: "inProgress",
              ...(title === undefined ? {} : { title }),
              data: toolInputData(accumulated),
            },
          },
        ],
        context,
      );
    }

    case "tool_exec": {
      const title = boundedNonEmpty(event.name, MAX_SCALAR_LENGTH);
      return result(
        {
          ...state,
          toolNames: withCappedEntry(
            state.toolNames,
            event.call_id,
            bounded(event.name, MAX_SCALAR_LENGTH),
            MAX_TRACKED_TOOL_CALLS,
          ),
        },
        [
          {
            ...base(context),
            type: "item.updated",
            itemId: toolItemId(event.call_id),
            payload: {
              itemType: canonicalToolItemType(event.name),
              status: "inProgress",
              ...(title === undefined ? {} : { title }),
            },
          },
        ],
        context,
      );
    }

    case "tool_done": {
      const failure = boundedNonEmpty(event.error);
      const detail = failure ?? boundedNonEmpty(event.output);
      const title = boundedNonEmpty(event.name, MAX_SCALAR_LENGTH);
      return result(
        {
          ...state,
          toolNames: withoutEntry(state.toolNames, event.call_id),
          toolInputs: withoutEntry(state.toolInputs, event.call_id),
        },
        [
          {
            ...base(context),
            type: "item.completed",
            itemId: toolItemId(event.call_id),
            payload: {
              itemType: canonicalToolItemType(event.name),
              status: failure === undefined ? "completed" : "failed",
              ...(title === undefined ? {} : { title }),
              ...(detail === undefined ? {} : { detail }),
            },
          },
        ],
        context,
      );
    }

    case "token_usage": {
      const inputTokens = nonNegativeInteger(event.input);
      const outputTokens = nonNegativeInteger(event.output);
      if (inputTokens === undefined || outputTokens === undefined) return ignored(state);
      const cachedInputTokens = nonNegativeInteger(event.cache_read_input);
      return result(
        state,
        [
          {
            ...base(context),
            type: "thread.token-usage.updated",
            payload: {
              usage: {
                usedTokens: inputTokens + outputTokens,
                inputTokens,
                outputTokens,
                ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
              },
            },
          },
        ],
        context,
      );
    }

    case "background_progress": {
      const description =
        boundedNonEmpty(event.label, MAX_SCALAR_LENGTH) ?? "Jcode background task";
      const summary = boundedNonEmpty(event.summary, MAX_SCALAR_LENGTH);
      const id = taskId(event.task_id);

      if (event.done === true) {
        const next = new Set(state.startedTasks);
        next.delete(event.task_id);
        return result(
          { ...state, startedTasks: next },
          [
            {
              ...base(context),
              type: "task.completed",
              payload: {
                taskId: id,
                status: "completed",
                title: description,
                ...(summary === undefined ? {} : { summary }),
              },
            },
          ],
          context,
        );
      }

      if (state.startedTasks.has(event.task_id)) {
        return result(
          state,
          [
            {
              ...base(context),
              type: "task.progress",
              payload: {
                taskId: id,
                description,
                title: description,
                status: "running",
                ...(summary === undefined ? {} : { summary }),
              },
            },
          ],
          context,
        );
      }

      const started = [...state.startedTasks, event.task_id].slice(-MAX_TRACKED_TASKS);
      return result(
        { ...state, startedTasks: new Set(started) },
        [
          {
            ...base(context),
            type: "task.started",
            payload: { taskId: id, description, title: description },
          },
        ],
        context,
      );
    }

    case "session_status": {
      const known = THREAD_STATE_BY_STATUS.get(event.status.trim().toLowerCase());
      const status = boundedNonEmpty(event.status, MAX_SCALAR_LENGTH);
      return result(
        state,
        [
          {
            ...base(context),
            type: "thread.state.changed",
            payload: {
              state: known ?? "active",
              ...(known === undefined && status !== undefined ? { detail: { status } } : {}),
            },
          },
        ],
        context,
      );
    }

    case "model_info": {
      const model = boundedNonEmpty(event.model, MAX_SCALAR_LENGTH);
      if (model === undefined || model === state.currentModel) return ignored(state);
      const previous = state.currentModel;
      if (previous === undefined) return ignored({ ...state, currentModel: model });
      return result(
        { ...state, currentModel: model },
        [
          {
            ...base(context),
            type: "model.rerouted",
            payload: {
              fromModel: previous,
              toModel: model,
              reason: "Jcode reported a different active model.",
            },
          },
        ],
        context,
      );
    }

    case "turn_done": {
      const drafts: JcodeRuntimeEventDraft[] = [
        ...closeOpenItems(state, context),
        {
          ...base(context),
          type: "turn.completed",
          payload: { state: "completed" },
        },
      ];
      return result(
        {
          ...initialJcodeEventMappingState,
          ...(state.currentModel === undefined ? {} : { currentModel: state.currentModel }),
        },
        drafts,
        context,
      );
    }

    case "permission_request": {
      // Never auto-approve, and never echo the native request id: answering
      // would silently grant access, and echoing would invite a downstream
      // caller to answer it. The turn cannot continue either way.
      const toolName = boundedNonEmpty(event.tool_name, MAX_SCALAR_LENGTH);
      return result(
        state,
        [
          {
            ...base(context),
            type: "runtime.error",
            payload: {
              message:
                "Jcode asked for an interactive permission decision, which this provider cannot answer.",
              class: "permission_error",
              ...(toolName === undefined ? {} : { detail: { toolName } }),
            },
          },
        ],
        context,
        true,
      );
    }

    // No durable activity: acknowledgement only.
    case "message_accepted":
    // Request replies and admin frames. The request methods that issued them
    // consume their own responses; `compacted` in particular is a compaction
    // acknowledgement and must never be read as turn completion.
    case "hello_ok":
    case "ok":
    case "error":
    case "sessions":
    case "attached":
    case "history":
    case "pong":
    case "models":
    case "runtime_info":
    case "credential_updated":
    case "file_content":
    case "files":
    case "text_matches":
    case "file_status":
    case "compacted":
    case "session_renamed":
      return ignored(state);

    default:
      // Forward compatibility: the harness may add events within protocol v1.
      return ignored(state);
  }
}
