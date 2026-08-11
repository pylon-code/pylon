/**
 * Pure mapping from Jcode SDK events to canonical provider runtime events.
 *
 * Everything Jcode-native stops here. The session runtime feeds one decoded
 * Jcode SDK event plus a stamp into `mapJcodeRuntimeEvent` and gets back complete
 * `ProviderRuntimeEvent` values; no wire schema, client state, or
 * provider-specific contract is introduced by this file.
 *
 * Four rules shape the mapping:
 *
 *   - **Nothing native reaches a client-visible field.** Native call and task
 *     IDs become opaque `jcode-tool:` / `jcode-task:` handles, and the native
 *     session ID is never copied anywhere. A permission request's `request_id`
 *     is dropped outright rather than echoed as a correlation handle.
 *   - **Every external string is trimmed, bounded, then rechecked.** The
 *     canonical schemas use `TrimmedNonEmptyString`, which trims during decode
 *     and then requires non-empty. Slicing first and checking the original
 *     produces an all-whitespace value that fails decode, so the order matters
 *     and a value with no content left is omitted rather than emitted blank.
 *   - **Every payload field must exist in the canonical schema.** Writing a
 *     field the schema does not define is silently dropped at the boundary,
 *     which reads locally like labeling and is downstream data loss.
 *   - **State is immutable and bounded, and nothing opened stays open.** Every
 *     item this mapper starts or updates is completed: at `tool_done`, at
 *     `turn_done`, or at the moment cap eviction makes it unreachable.
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

import type { JcodeStreamCorrectionEvent } from "./JcodeSdkBridge.ts";

const JCODE_PROVIDER = ProviderDriverKind.make("jcode");

/** Streamed assistant text and tool output; matches the canonical text bound. */
const MAX_TEXT_LENGTH = 100_000;
/** Titles, descriptions, summaries, and any scalar echoed from the harness. */
const MAX_SCALAR_LENGTH = 4_000;
/** Accumulated tool-call input retained for JSON completion detection. */
const MAX_TOOL_INPUT_LENGTH = 8_000;
/** Concurrent tool calls tracked per session. */
export const MAX_TRACKED_TOOL_CALLS = 64;
/** Started and recently-completed background tasks tracked per session. */
export const MAX_TRACKED_TASKS = 64;
/**
 * Turn segments before the counter wraps.
 *
 * Segment identity only has to distinguish items that can be live at the same
 * time, and a Pylon turn holds at most a handful. Wrapping keeps the ID short
 * and the state bounded; a monotonic counter would grow a durable ID with the
 * session's lifetime for no benefit.
 */
export const MAX_TURN_SEGMENTS = 1_000;

export interface JcodeEventMappingContext {
  readonly eventId: EventId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly createdAt: string;
}

/**
 * One tool call this mapper has an open item for.
 *
 * `name` is optional because a `tool_input_delta` can arrive before its
 * `tool_start`: the item still has to be tracked (and eventually closed) even
 * though its canonical type is not yet known.
 */
export interface JcodeOpenToolCall {
  readonly name?: string;
  readonly input: string;
}

/**
 * Adapter-local state for lifecycles that span several SDK events.
 *
 * One map covers tool calls rather than parallel name/input maps: the close set
 * at `turn_done` must be exactly the set of items this mapper opened, and two
 * maps made that set a union whose halves could drift apart.
 */
export interface JcodeEventMappingState {
  readonly assistantStarted: boolean;
  readonly reasoningStarted: boolean;
  readonly openTools: ReadonlyMap<string, JcodeOpenToolCall>;
  readonly openRetryItemId?: RuntimeItemId;
  readonly startedTasks: ReadonlySet<string>;
  readonly completedTasks: ReadonlySet<string>;
  /** Distinguishes assistant/reasoning items across `turn_done` boundaries. */
  readonly segment: number;
  /** Distinguishes regenerated assistant, reasoning, and tool items after retries. */
  readonly attemptGeneration: number;
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
  openTools: new Map(),
  startedTasks: new Set(),
  completedTasks: new Set(),
  segment: 0,
  attemptGeneration: 0,
};

type RuntimeEventDraft<Event> = Event extends ProviderRuntimeEvent ? Omit<Event, "eventId"> : never;
type JcodeRuntimeEventDraft = RuntimeEventDraft<ProviderRuntimeEvent>;

function bounded(value: string, maximum = MAX_TEXT_LENGTH): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

/**
 * Trim, then bound, then trim again.
 *
 * The second trim matters: slicing a value whose content sits just past the
 * bound can leave trailing whitespace, and `TrimmedNonEmptyString` would reject
 * the result. When nothing survives, the caller omits the field rather than
 * emitting a blank one.
 */
function boundedNonEmpty(value: string | undefined, maximum = MAX_TEXT_LENGTH): string | undefined {
  if (value === undefined) return undefined;
  const sliced = bounded(value.trim(), maximum).trim();
  return sliced.length === 0 ? undefined : sliced;
}

/** Opaque, deterministic, and reversible only inside this server process. */
function opaqueId(prefix: string, nativeId: string): string {
  return `${prefix}:${Buffer.from(nativeId, "utf8").toString("base64url")}`;
}

function toolItemId(state: JcodeEventMappingState, callId: string): RuntimeItemId {
  return RuntimeItemId.make(
    `jcode-tool:${state.attemptGeneration}:${Buffer.from(callId, "utf8").toString("base64url")}`,
  );
}

function taskId(nativeTaskId: string): RuntimeTaskId {
  return RuntimeTaskId.make(opaqueId("jcode-task", nativeTaskId));
}

/**
 * Assistant and reasoning items are keyed by the Pylon turn (thread when the
 * mapper runs outside a turn) plus a segment, never by anything the harness
 * supplied. The segment advances at `turn_done`, so a harness that ends several
 * segments inside one Pylon turn cannot re-open a durable item that already
 * received its terminal row.
 */
function assistantItemId(
  state: JcodeEventMappingState,
  context: JcodeEventMappingContext,
): RuntimeItemId {
  return RuntimeItemId.make(
    `jcode-assistant:${context.turnId ?? context.threadId}:${state.segment}:${state.attemptGeneration}`,
  );
}

function reasoningItemId(
  state: JcodeEventMappingState,
  context: JcodeEventMappingContext,
): RuntimeItemId {
  return RuntimeItemId.make(
    `jcode-reasoning:${context.turnId ?? context.threadId}:${state.segment}:${state.attemptGeneration}`,
  );
}

function retryItemId(
  state: JcodeEventMappingState,
  context: JcodeEventMappingContext & { readonly turnId: TurnId },
): RuntimeItemId {
  return RuntimeItemId.make(
    `jcode-retry:${context.turnId}:${state.segment}:${state.attemptGeneration}`,
  );
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

/** Newest-wins insertion with a hard cap on a set of bare IDs. */
function withCappedMember(
  members: ReadonlySet<string>,
  value: string,
  maximum: number,
): ReadonlySet<string> {
  const next = new Set(members);
  next.delete(value);
  next.add(value);
  while (next.size > maximum) {
    const oldest = next.values().next();
    if (oldest.done === true) break;
    next.delete(oldest.value);
  }
  return next;
}

function withoutMember(members: ReadonlySet<string>, value: string): ReadonlySet<string> {
  if (!members.has(value)) return members;
  const next = new Set(members);
  next.delete(value);
  return next;
}

function nameTokens(toolName: string): ReadonlyArray<string> {
  return toolName
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function canonicalToolItemType(toolName: string | undefined): ToolLifecycleItemType {
  if (toolName === undefined) return "dynamic_tool_call";
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

const UNFINISHED_TOOL_DETAIL = "The tool call did not report completion before the turn ended.";
const EVICTED_TOOL_DETAIL =
  "Jcode reported more concurrent tool calls than this provider tracks, so this one can no longer be followed.";

/** The terminal row for a tool item this mapper opened but never saw finish. */
function abandonedToolDraft(
  state: JcodeEventMappingState,
  call: JcodeOpenToolCall,
  callId: string,
  detail: string,
  context: JcodeEventMappingContext,
): JcodeRuntimeEventDraft {
  const title = boundedNonEmpty(call.name, MAX_SCALAR_LENGTH);
  return {
    ...base(context),
    type: "item.completed",
    itemId: toolItemId(state, callId),
    payload: {
      itemType: canonicalToolItemType(call.name),
      status: "failed",
      ...(title === undefined ? {} : { title }),
      detail,
    },
  };
}

/**
 * Records an open tool call, evicting the oldest entry when the cap is reached.
 *
 * Eviction emits the evicted call's terminal row immediately: once it leaves
 * the map, `turn_done` can no longer see it, and an item that is never
 * completed spins in every client forever.
 */
function trackOpenTool(
  state: JcodeEventMappingState,
  callId: string,
  call: JcodeOpenToolCall,
  context: JcodeEventMappingContext,
): {
  readonly openTools: ReadonlyMap<string, JcodeOpenToolCall>;
  readonly evictions: ReadonlyArray<JcodeRuntimeEventDraft>;
} {
  const next = new Map(state.openTools);
  next.delete(callId);
  next.set(callId, call);

  const evictions: JcodeRuntimeEventDraft[] = [];
  while (next.size > MAX_TRACKED_TOOL_CALLS) {
    const oldest = next.entries().next();
    if (oldest.done === true) break;
    const [evictedId, evicted] = oldest.value;
    next.delete(evictedId);
    evictions.push(abandonedToolDraft(state, evicted, evictedId, EVICTED_TOOL_DETAIL, context));
  }
  return { openTools: next, evictions };
}

function withoutOpenTool(
  openTools: ReadonlyMap<string, JcodeOpenToolCall>,
  callId: string,
): ReadonlyMap<string, JcodeOpenToolCall> {
  if (!openTools.has(callId)) return openTools;
  const next = new Map(openTools);
  next.delete(callId);
  return next;
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

function retryCompletionDraft(
  itemId: RuntimeItemId,
  status: "completed" | "failed",
  context: JcodeEventMappingContext,
): JcodeRuntimeEventDraft {
  return {
    ...base(context),
    type: "item.completed",
    itemId,
    payload: { itemType: "retry", status, title: "Provider retry" },
  };
}

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
      itemId: assistantItemId(state, context),
      payload: { itemType: "assistant_message", status: "completed" },
    });
  }
  if (state.reasoningStarted) {
    drafts.push({
      ...base(context),
      type: "item.completed",
      itemId: reasoningItemId(state, context),
      payload: { itemType: "reasoning", status: "completed", title: "Reasoning" },
    });
  }
  for (const [callId, call] of state.openTools) {
    drafts.push(abandonedToolDraft(state, call, callId, UNFINISHED_TOOL_DETAIL, context));
  }
  if (state.openRetryItemId !== undefined) {
    drafts.push(retryCompletionDraft(state.openRetryItemId, "completed", context));
  }
  return drafts;
}

/**
 * After a reset, an untracked continuation is indistinguishable from a frame
 * still draining from the invalidated attempt. A current-generation tool must
 * therefore establish its identity with `tool_start` before it can be updated
 * or completed. Generation zero retains the SDK's pre-existing tolerant order.
 */
function isPostResetToolStraggler(state: JcodeEventMappingState, callId: string): boolean {
  return state.attemptGeneration > 0 && !state.openTools.has(callId);
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
  event: ApiEvent | JcodeStreamCorrectionEvent,
  context: JcodeEventMappingContext,
): JcodeEventMappingResult {
  switch (event.ev) {
    case "text_replace": {
      if (context.turnId === undefined) {
        return result(
          state,
          [
            {
              ...base(context),
              type: "runtime.error",
              payload: {
                message: "Jcode reported replacement text without an active Pylon turn.",
                class: "validation_error",
              },
            },
          ],
          context,
          true,
        );
      }
      const text = bounded(event.text);
      const itemId = assistantItemId(state, context);
      const drafts: JcodeRuntimeEventDraft[] = [];
      if (!state.assistantStarted) {
        drafts.push({
          ...base(context),
          type: "item.started",
          itemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
      }
      drafts.push({
        ...base(context),
        turnId: context.turnId,
        type: "content.replaced",
        itemId,
        payload: { streamKind: "assistant_text", text },
      });
      return result({ ...state, assistantStarted: true }, drafts, context);
    }

    case "retry_rollback": {
      if (context.turnId === undefined) {
        return result(
          state,
          [
            {
              ...base(context),
              type: "runtime.error",
              payload: {
                message: "Jcode reported a retry without an active Pylon turn.",
                class: "validation_error",
              },
            },
          ],
          context,
          true,
        );
      }
      const retryContext = { ...context, turnId: context.turnId };
      const nextState: JcodeEventMappingState = {
        ...state,
        assistantStarted: false,
        reasoningStarted: false,
        openTools: new Map(),
        segment: (state.segment + 1) % MAX_TURN_SEGMENTS,
        attemptGeneration: state.attemptGeneration + 1,
      };
      const nextRetryItemId = retryItemId(nextState, retryContext);
      return result(
        { ...nextState, openRetryItemId: nextRetryItemId },
        [
          ...(state.openRetryItemId === undefined
            ? []
            : [retryCompletionDraft(state.openRetryItemId, "failed", retryContext)]),
          {
            ...base(retryContext),
            turnId: retryContext.turnId,
            type: "turn.output-reset",
            payload: { reason: "provider_retry", attempt: event.attempt, max: event.max },
          },
          {
            ...base(retryContext),
            type: "item.started",
            itemId: nextRetryItemId,
            payload: {
              itemType: "retry",
              status: "inProgress",
              title: "Provider retry",
              data: { attempt: event.attempt, maxAttempts: event.max },
            },
          },
        ],
        retryContext,
      );
    }

    case "text_delta": {
      const delta = bounded(event.text);
      const itemId = assistantItemId(state, context);
      const drafts: JcodeRuntimeEventDraft[] = [];
      if (!state.assistantStarted) {
        drafts.push({
          ...base(context),
          type: "item.started",
          itemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
      }
      drafts.push({
        ...base(context),
        type: "content.delta",
        itemId,
        payload: { streamKind: "assistant_text", delta },
      });
      return result({ ...state, assistantStarted: true }, drafts, context);
    }

    case "reasoning_delta": {
      const delta = bounded(event.text);
      const itemId = reasoningItemId(state, context);
      const drafts: JcodeRuntimeEventDraft[] = [];
      if (!state.reasoningStarted) {
        drafts.push({
          ...base(context),
          type: "item.started",
          itemId,
          payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" },
        });
      }
      drafts.push({
        ...base(context),
        type: "content.delta",
        itemId,
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
            itemId: reasoningItemId(state, context),
            payload: { itemType: "reasoning", status: "completed", title: "Reasoning" },
          },
        ],
        context,
      );
    }

    case "tool_start": {
      const name = boundedNonEmpty(event.name, MAX_SCALAR_LENGTH);
      const { openTools, evictions } = trackOpenTool(
        state,
        event.call_id,
        { ...(name === undefined ? {} : { name }), input: "" },
        context,
      );
      return result(
        { ...state, openTools },
        [
          ...evictions,
          {
            ...base(context),
            type: "item.started",
            itemId: toolItemId(state, event.call_id),
            payload: {
              itemType: canonicalToolItemType(name),
              status: "inProgress",
              ...(name === undefined ? {} : { title: name }),
            },
          },
        ],
        context,
      );
    }

    case "tool_input_delta": {
      if (isPostResetToolStraggler(state, event.call_id)) return ignored(state);
      const existing = state.openTools.get(event.call_id);
      const accumulated = bounded(`${existing?.input ?? ""}${event.delta}`, MAX_TOOL_INPUT_LENGTH);
      const name = existing?.name;
      const { openTools, evictions } = trackOpenTool(
        state,
        event.call_id,
        { ...(name === undefined ? {} : { name }), input: accumulated },
        context,
      );
      return result(
        { ...state, openTools },
        [
          ...evictions,
          {
            ...base(context),
            type: "item.updated",
            itemId: toolItemId(state, event.call_id),
            payload: {
              itemType: canonicalToolItemType(name),
              status: "inProgress",
              ...(name === undefined ? {} : { title: name }),
              data: toolInputData(accumulated),
            },
          },
        ],
        context,
      );
    }

    case "tool_exec": {
      if (isPostResetToolStraggler(state, event.call_id)) return ignored(state);
      const name = boundedNonEmpty(event.name, MAX_SCALAR_LENGTH);
      const existing = state.openTools.get(event.call_id);
      const { openTools, evictions } = trackOpenTool(
        state,
        event.call_id,
        { ...(name === undefined ? {} : { name }), input: existing?.input ?? "" },
        context,
      );
      return result(
        { ...state, openTools },
        [
          ...evictions,
          {
            ...base(context),
            type: "item.updated",
            itemId: toolItemId(state, event.call_id),
            payload: {
              itemType: canonicalToolItemType(name),
              status: "inProgress",
              ...(name === undefined ? {} : { title: name }),
            },
          },
        ],
        context,
      );
    }

    case "tool_done": {
      if (isPostResetToolStraggler(state, event.call_id)) return ignored(state);
      // Tolerant by design: a `tool_done` for a call this mapper never opened
      // still completes. The harness owns call identity, and a client that saw
      // the start through another path would otherwise hold a row that never
      // resolves. Completing an item nobody started is inert; leaving one open
      // is a permanent spinner.
      const failure = boundedNonEmpty(event.error);
      const detail = failure ?? boundedNonEmpty(event.output);
      const title = boundedNonEmpty(event.name, MAX_SCALAR_LENGTH);
      return result(
        { ...state, openTools: withoutOpenTool(state.openTools, event.call_id) },
        [
          {
            ...base(context),
            type: "item.completed",
            itemId: toolItemId(state, event.call_id),
            payload: {
              itemType: canonicalToolItemType(title),
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
      // Two individually-safe counters can sum past the safe-integer range, and
      // `NonNegativeInt` rejects the result. Report nothing rather than a
      // number that fails canonical decode downstream.
      const usedTokens = nonNegativeInteger(inputTokens + outputTokens);
      if (usedTokens === undefined) return ignored(state);
      const cachedInputTokens = nonNegativeInteger(event.cache_read_input);
      return result(
        state,
        [
          {
            ...base(context),
            type: "thread.token-usage.updated",
            payload: {
              usage: {
                usedTokens,
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
        // A repeated terminal frame must not produce a second terminal row.
        // Tracking is capped like everything else, so a very long-lived session
        // can eventually forget a completion and repeat it; that is the bounded
        // trade, and it beats unbounded growth.
        if (state.completedTasks.has(event.task_id)) return ignored(state);
        return result(
          {
            ...state,
            startedTasks: withoutMember(state.startedTasks, event.task_id),
            completedTasks: withCappedMember(
              state.completedTasks,
              event.task_id,
              MAX_TRACKED_TASKS,
            ),
          },
          [
            {
              ...base(context),
              // `TaskCompletedPayload` defines no `title`, so the label is
              // folded into `summary`, the only free-text field it has.
              // Writing `title` here would silently drop the label.
              type: "task.completed",
              payload: {
                taskId: id,
                status: "completed",
                taskType: "shell",
                summary: summary ?? description,
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
                status: "running",
                taskType: "shell",
                ...(summary === undefined ? {} : { summary }),
              },
            },
          ],
          context,
        );
      }

      return result(
        {
          ...state,
          startedTasks: withCappedMember(state.startedTasks, event.task_id, MAX_TRACKED_TASKS),
          // A task that reports progress after completing has restarted, so it
          // is allowed to reach a terminal row again.
          completedTasks: withoutMember(state.completedTasks, event.task_id),
        },
        [
          {
            ...base(context),
            type: "task.started",
            payload: { taskId: id, description, taskType: "shell" },
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
          // Model and task identity outlive one segment; item identity does not.
          ...(state.currentModel === undefined ? {} : { currentModel: state.currentModel }),
          startedTasks: state.startedTasks,
          completedTasks: state.completedTasks,
          segment: (state.segment + 1) % MAX_TURN_SEGMENTS,
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
