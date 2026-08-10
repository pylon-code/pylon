import type { ApiEvent } from "@1jehuang/jcode-sdk";
import {
  EventId,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import {
  MAX_TRACKED_TOOL_CALLS,
  MAX_TURN_SEGMENTS,
  initialJcodeEventMappingState,
  mapJcodeRuntimeEvent,
  type JcodeEventMappingContext,
  type JcodeEventMappingState,
} from "./JcodeRuntimeEvents.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

/**
 * Bounds and payload shapes are asserted by decoding through the real
 * contract, never by measuring `.length`. A bounded value can satisfy a length
 * assertion and still fail `TrimmedNonEmptyString`, which is exactly how the
 * whitespace and token-overflow defects reached review.
 */
function decodeAll(events: ReadonlyArray<ProviderRuntimeEvent>): void {
  for (const event of events) {
    expect(() => decodeRuntimeEvent(event), `failed to decode ${event.type}`).not.toThrow();
  }
}

const NATIVE_SESSION_ID = "native-session-abc";
const NATIVE_CALL_ID = "native-call-abc";
const NATIVE_TASK_ID = "native-task-abc";
const NATIVE_REQUEST_ID = "native-request-abc";

/** First 4,000+ characters are whitespace, so slice-then-check yields blank. */
const WHITESPACE_HEAVY = `${" ".repeat(5_000)}realname`;

function context(overrides: Partial<JcodeEventMappingContext> = {}): JcodeEventMappingContext {
  return {
    eventId: EventId.make("event-1"),
    providerInstanceId: ProviderInstanceId.make("jcode_local"),
    threadId: ThreadId.make("thread-1"),
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

interface FoldResult {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly state: JcodeEventMappingState;
  readonly fatal: boolean;
}

/** Folds a whole SDK event sequence the way the session runtime will. */
function run(
  events: ReadonlyArray<ApiEvent>,
  overrides: Partial<JcodeEventMappingContext> = {},
  initial: JcodeEventMappingState = initialJcodeEventMappingState,
): FoldResult {
  let state = initial;
  let fatal = false;
  const emitted: ProviderRuntimeEvent[] = [];
  events.forEach((event, index) => {
    const result = mapJcodeRuntimeEvent(
      state,
      event,
      context({ eventId: EventId.make(`event-${index + 1}`), ...overrides }),
    );
    state = result.state;
    fatal = fatal || result.fatal;
    emitted.push(...result.events);
  });
  return { events: emitted, state, fatal };
}

const textDelta = (text: string): ApiEvent => ({
  ev: "text_delta",
  session_id: NATIVE_SESSION_ID,
  text,
});
const reasoningDelta = (text: string): ApiEvent => ({
  ev: "reasoning_delta",
  session_id: NATIVE_SESSION_ID,
  text,
});
const toolStart = (name: string, callId = NATIVE_CALL_ID): ApiEvent => ({
  ev: "tool_start",
  session_id: NATIVE_SESSION_ID,
  call_id: callId,
  name,
});
const toolInputDelta = (delta: string, callId = NATIVE_CALL_ID): ApiEvent => ({
  ev: "tool_input_delta",
  session_id: NATIVE_SESSION_ID,
  call_id: callId,
  delta,
});
const turnDone = (): ApiEvent => ({ ev: "turn_done", session_id: NATIVE_SESSION_ID });

const TOOL_ITEM_ID = `jcode-tool:${Buffer.from(NATIVE_CALL_ID, "utf8").toString("base64url")}`;
const TASK_ID = `jcode-task:${Buffer.from(NATIVE_TASK_ID, "utf8").toString("base64url")}`;
const toolItemIdFor = (callId: string) =>
  `jcode-tool:${Buffer.from(callId, "utf8").toString("base64url")}`;

type ItemStarted = Extract<ProviderRuntimeEvent, { type: "item.started" }>;
type ItemUpdated = Extract<ProviderRuntimeEvent, { type: "item.updated" }>;
type ItemCompleted = Extract<ProviderRuntimeEvent, { type: "item.completed" }>;
type TaskStarted = Extract<ProviderRuntimeEvent, { type: "task.started" }>;
type TaskProgress = Extract<ProviderRuntimeEvent, { type: "task.progress" }>;
type TaskCompleted = Extract<ProviderRuntimeEvent, { type: "task.completed" }>;
type ContentDelta = Extract<ProviderRuntimeEvent, { type: "content.delta" }>;
type ThreadStateChanged = Extract<ProviderRuntimeEvent, { type: "thread.state.changed" }>;

describe("JcodeRuntimeEvents", () => {
  it("streams assistant text as one started item followed by deltas", () => {
    const result = run([textDelta("he"), textDelta("llo")]);

    expect(result.events.map((event) => event.type)).toEqual([
      "item.started",
      "content.delta",
      "content.delta",
    ]);
    expect(result.events[0]).toMatchObject({
      type: "item.started",
      payload: { itemType: "assistant_message", status: "inProgress" },
    });
    expect(result.events[1]).toMatchObject({
      type: "content.delta",
      payload: { streamKind: "assistant_text", delta: "he" },
    });
    const itemIds = new Set(result.events.map((event) => event.itemId));
    expect(itemIds.size).toBe(1);
    expect(result.state.assistantStarted).toBe(true);
    decodeAll(result.events);
  });

  it("streams reasoning as one started item, deltas, then completion", () => {
    const result = run([
      reasoningDelta("thinking"),
      reasoningDelta(" more"),
      { ev: "reasoning_done", session_id: NATIVE_SESSION_ID, duration_secs: 3 },
    ]);

    expect(result.events.map((event) => event.type)).toEqual([
      "item.started",
      "content.delta",
      "content.delta",
      "item.completed",
    ]);
    expect(result.events[0]).toMatchObject({
      payload: { itemType: "reasoning", status: "inProgress" },
    });
    expect(result.events[1]).toMatchObject({
      payload: { streamKind: "reasoning_text", delta: "thinking" },
    });
    expect(result.events[3]).toMatchObject({
      type: "item.completed",
      payload: { itemType: "reasoning", status: "completed" },
    });
    expect(result.state.reasoningStarted).toBe(false);
    decodeAll(result.events);
  });

  it("ignores reasoning_done when no reasoning item is open", () => {
    const result = run([{ ev: "reasoning_done", session_id: NATIVE_SESSION_ID }]);
    expect(result.events).toEqual([]);
  });

  it("maps tool names to canonical item types with bounded titles", () => {
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["bash", "command_execution"],
      ["run_shell_command", "command_execution"],
      ["edit_file", "file_change"],
      ["apply_patch", "file_change"],
      ["write", "file_change"],
      ["web_search", "web_search"],
      ["mcp__linear__issue", "mcp_tool_call"],
      ["some_future_tool", "dynamic_tool_call"],
    ];

    for (const [name, itemType] of rows) {
      const result = run([toolStart(name)]);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        type: "item.started",
        itemId: TOOL_ITEM_ID,
        payload: { itemType, status: "inProgress", title: name },
      });
      decodeAll(result.events);
    }

    const longName = "x".repeat(10_000);
    const bounded = run([toolStart(longName)]);
    expect((bounded.events[0] as ItemStarted).payload.title?.length).toBeLessThanOrEqual(4_000);
    decodeAll(bounded.events);
  });

  // F1 regression: trim, then bound, then recheck.
  it("decodes tool titles whose leading characters are all whitespace", () => {
    const started = run([toolStart(WHITESPACE_HEAVY)]);
    expect((started.events[0] as ItemStarted).payload.title).toBe("realname");
    decodeAll(started.events);

    const exec = run([
      {
        ev: "tool_exec",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        name: WHITESPACE_HEAVY,
      },
    ]);
    expect((exec.events[0] as ItemUpdated).payload.title).toBe("realname");
    decodeAll(exec.events);

    const done = run([
      {
        ev: "tool_done",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        name: WHITESPACE_HEAVY,
        output: WHITESPACE_HEAVY,
      },
    ]);
    expect((done.events[0] as ItemCompleted).payload.title).toBe("realname");
    expect((done.events[0] as ItemCompleted).payload.detail).toBe("realname");
    decodeAll(done.events);

    const errored = run([
      {
        ev: "tool_done",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        name: "bash",
        output: "",
        error: WHITESPACE_HEAVY,
      },
    ]);
    expect((errored.events[0] as ItemCompleted).payload).toMatchObject({
      status: "failed",
      detail: "realname",
    });
    decodeAll(errored.events);
  });

  // F1 regression: a stored tool name must be trimmed too, or a later
  // tool_input_delta re-emits the blank title from adapter-local state.
  it("decodes titles echoed from stored tool names after a whitespace-heavy start", () => {
    const result = run([toolStart(WHITESPACE_HEAVY), toolInputDelta("{}")]);
    const updated = result.events.at(-1) as ItemUpdated;
    expect(updated.payload.title).toBe("realname");
    decodeAll(result.events);
  });

  // F1 regression: an all-whitespace value has no honest label, so the field
  // is omitted rather than emitted blank.
  it("omits labels entirely when an external string is only whitespace", () => {
    const tool = run([toolStart("   \n\t  ")]);
    expect((tool.events[0] as ItemStarted).payload.title).toBeUndefined();
    expect("title" in (tool.events[0] as ItemStarted).payload).toBe(false);
    decodeAll(tool.events);

    const task = run([
      {
        ev: "background_progress",
        session_id: NATIVE_SESSION_ID,
        task_id: NATIVE_TASK_ID,
        label: "   ",
        summary: "   ",
      },
    ]);
    expect((task.events[0] as TaskStarted).payload.description).toBe("Jcode background task");
    decodeAll(task.events);

    const status = run([{ ev: "session_status", session_id: NATIVE_SESSION_ID, status: "   " }]);
    expect((status.events[0] as ThreadStateChanged).payload).toEqual({ state: "active" });
    decodeAll(status.events);
  });

  // F1 regression: whitespace-heavy task label and summary.
  it("decodes task labels and summaries whose leading characters are whitespace", () => {
    const result = run([
      {
        ev: "background_progress",
        session_id: NATIVE_SESSION_ID,
        task_id: NATIVE_TASK_ID,
        label: WHITESPACE_HEAVY,
        summary: WHITESPACE_HEAVY,
      },
    ]);
    expect((result.events[0] as TaskStarted).payload.description).toBe("realname");
    decodeAll(result.events);
  });

  // F1 regression: whitespace-heavy unknown session status detail.
  it("decodes unknown session statuses whose leading characters are whitespace", () => {
    const result = run([
      { ev: "session_status", session_id: NATIVE_SESSION_ID, status: `${WHITESPACE_HEAVY}-status` },
    ]);
    expect((result.events[0] as ThreadStateChanged).payload).toMatchObject({
      state: "active",
      detail: { status: "realname-status" },
    });
    decodeAll(result.events);
  });

  // F1 regression: whitespace-heavy permission tool name.
  it("decodes permission errors whose tool name is whitespace heavy", () => {
    const result = run([
      {
        ev: "permission_request",
        session_id: NATIVE_SESSION_ID,
        request_id: NATIVE_REQUEST_ID,
        tool_name: WHITESPACE_HEAVY,
        description: "run something",
      },
    ]);
    expect(result.fatal).toBe(true);
    decodeAll(result.events);
  });

  // F1 regression: whitespace-heavy model names must not become blank
  // fromModel/toModel values on model.rerouted.
  it("decodes model reroutes whose model names are whitespace heavy", () => {
    const result = run([
      { ev: "model_info", session_id: NATIVE_SESSION_ID, model: `${WHITESPACE_HEAVY}-a` },
      { ev: "model_info", session_id: NATIVE_SESSION_ID, model: `${WHITESPACE_HEAVY}-b` },
    ]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: "model.rerouted",
      payload: { fromModel: "realname-a", toModel: "realname-b" },
    });
    decodeAll(result.events);
  });

  it("parses accumulated tool input only when the whole value is valid JSON", () => {
    const partial = run([toolStart("bash"), toolInputDelta('{"command":')]);
    const partialUpdate = partial.events.at(-1);
    expect(partialUpdate).toMatchObject({
      type: "item.updated",
      itemId: TOOL_ITEM_ID,
      payload: { itemType: "command_execution", status: "inProgress" },
    });
    expect((partialUpdate as ItemUpdated).payload.data).toEqual({ input: '{"command":' });
    expect(partial.state.openTools.get(NATIVE_CALL_ID)?.input).toBe('{"command":');
    decodeAll(partial.events);

    const complete = run([
      toolStart("bash"),
      toolInputDelta('{"command":'),
      toolInputDelta('"ls -la"}'),
    ]);
    expect((complete.events.at(-1) as ItemUpdated).payload.data).toEqual({ command: "ls -la" });
    decodeAll(complete.events);
  });

  it("bounds accumulated tool input and the number of tracked calls", () => {
    const chunk = "a".repeat(5_000);
    const result = run([
      toolStart("bash"),
      toolInputDelta(chunk),
      toolInputDelta(chunk),
      toolInputDelta(chunk),
    ]);
    expect(result.state.openTools.get(NATIVE_CALL_ID)?.input.length).toBeLessThanOrEqual(8_000);
    decodeAll(result.events);

    const manyCalls = Array.from({ length: 300 }, (_, index) => toolStart("bash", `call-${index}`));
    expect(run(manyCalls).state.openTools.size).toBe(MAX_TRACKED_TOOL_CALLS);
  });

  it("reports tool execution progress and completion, failing when an error is present", () => {
    const ok = run([
      toolStart("bash"),
      { ev: "tool_exec", session_id: NATIVE_SESSION_ID, call_id: NATIVE_CALL_ID, name: "bash" },
      {
        ev: "tool_done",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        name: "bash",
        output: "total 0",
      },
    ]);
    expect(ok.events.map((event) => event.type)).toEqual([
      "item.started",
      "item.updated",
      "item.completed",
    ]);
    expect(ok.events[1]).toMatchObject({ payload: { status: "inProgress" } });
    expect(ok.events[2]).toMatchObject({
      itemId: TOOL_ITEM_ID,
      payload: { itemType: "command_execution", status: "completed", detail: "total 0" },
    });
    expect(ok.state.openTools.size).toBe(0);
    decodeAll(ok.events);

    const failed = run([
      toolStart("bash"),
      {
        ev: "tool_done",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        name: "bash",
        output: "",
        error: "exit status 1",
      },
    ]);
    expect(failed.events.at(-1)).toMatchObject({
      payload: { status: "failed", detail: "exit status 1" },
    });
    decodeAll(failed.events);
  });

  it("maps token usage into the canonical thread usage snapshot", () => {
    const result = run([
      {
        ev: "token_usage",
        session_id: NATIVE_SESSION_ID,
        input: 120,
        output: 30,
        cache_read_input: 90,
      },
    ]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: "thread.token-usage.updated",
      payload: {
        usage: { usedTokens: 150, inputTokens: 120, outputTokens: 30, cachedInputTokens: 90 },
      },
    });
    decodeAll(result.events);
  });

  it("ignores token usage with non-integer or negative counters", () => {
    expect(
      run([{ ev: "token_usage", session_id: NATIVE_SESSION_ID, input: -1, output: 3 }]).events,
    ).toEqual([]);
    expect(
      run([{ ev: "token_usage", session_id: NATIVE_SESSION_ID, input: 1.5, output: 3 }]).events,
    ).toEqual([]);
    expect(
      run([
        {
          ev: "token_usage",
          session_id: NATIVE_SESSION_ID,
          input: 1,
          output: 2,
          cache_read_input: -5,
        },
      ]).events[0],
    ).toMatchObject({ payload: { usage: { usedTokens: 3 } } });
  });

  // F2 regression: two individually safe counters can sum past the safe range.
  it("drops token usage whose computed sum leaves the safe integer range", () => {
    const overflow = run([
      {
        ev: "token_usage",
        session_id: NATIVE_SESSION_ID,
        input: Number.MAX_SAFE_INTEGER,
        output: Number.MAX_SAFE_INTEGER,
      },
    ]);
    expect(overflow.events).toEqual([]);

    const boundary = run([
      {
        ev: "token_usage",
        session_id: NATIVE_SESSION_ID,
        input: Number.MAX_SAFE_INTEGER - 1,
        output: 1,
      },
    ]);
    expect(boundary.events).toHaveLength(1);
    expect(boundary.events[0]).toMatchObject({
      payload: { usage: { usedTokens: Number.MAX_SAFE_INTEGER } },
    });
    decodeAll(boundary.events);
  });

  it("keys background progress by an opaque task id across its lifecycle", () => {
    const progress = (overrides: Partial<Extract<ApiEvent, { ev: "background_progress" }>>) =>
      ({
        ev: "background_progress",
        session_id: NATIVE_SESSION_ID,
        task_id: NATIVE_TASK_ID,
        label: "Indexing repository",
        summary: "scanning files",
        ...overrides,
      }) as ApiEvent;

    const result = run([
      progress({}),
      progress({ percent: 50, summary: "half way" }),
      progress({ done: true, summary: "finished" }),
    ]);

    expect(result.events.map((event) => event.type)).toEqual([
      "task.started",
      "task.progress",
      "task.completed",
    ]);
    expect(result.events[0]).toMatchObject({
      payload: { taskId: TASK_ID, description: "Indexing repository" },
    });
    expect(result.events[1]).toMatchObject({
      payload: { taskId: TASK_ID, description: "Indexing repository", summary: "half way" },
    });
    expect(result.events[2]).toMatchObject({
      payload: { taskId: TASK_ID, status: "completed", summary: "finished" },
    });
    expect(result.state.startedTasks.size).toBe(0);
    decodeAll(result.events);
  });

  // F3 regression: `title` is not a field of any task payload, so a completion
  // label survives only through a field the canonical schema defines.
  it("labels task rows only through fields the canonical task schemas define", () => {
    const result = run([
      {
        ev: "background_progress",
        session_id: NATIVE_SESSION_ID,
        task_id: NATIVE_TASK_ID,
        label: "Indexing repository",
        summary: "",
      },
      {
        ev: "background_progress",
        session_id: NATIVE_SESSION_ID,
        task_id: NATIVE_TASK_ID,
        label: "Indexing repository",
        summary: "",
      },
      {
        ev: "background_progress",
        session_id: NATIVE_SESSION_ID,
        task_id: NATIVE_TASK_ID,
        label: "Indexing repository",
        summary: "",
        done: true,
      },
    ]);

    const [started, progressed, completed] = result.events as [
      TaskStarted,
      TaskProgress,
      TaskCompleted,
    ];
    expect("title" in started.payload).toBe(false);
    expect("title" in progressed.payload).toBe(false);
    expect("title" in completed.payload).toBe(false);
    // The completion still carries the label, folded into a defined field.
    expect(completed.payload.summary).toBe("Indexing repository");
    decodeAll(result.events);
  });

  it("completes a background task that is already done on first sight", () => {
    const result = run([
      {
        ev: "background_progress",
        session_id: NATIVE_SESSION_ID,
        task_id: NATIVE_TASK_ID,
        label: "Indexing",
        summary: "done",
        done: true,
      },
    ]);
    expect(result.events.map((event) => event.type)).toEqual(["task.completed"]);
    decodeAll(result.events);
  });

  // F6 regression: a repeated terminal frame must not duplicate the terminal row.
  it("suppresses duplicate task completions with bounded state", () => {
    const done = {
      ev: "background_progress",
      session_id: NATIVE_SESSION_ID,
      task_id: NATIVE_TASK_ID,
      label: "Indexing",
      summary: "finished",
      done: true,
    } as ApiEvent;

    const result = run([done, done, done]);
    expect(result.events.map((event) => event.type)).toEqual(["task.completed"]);
    expect(result.state.completedTasks.has(NATIVE_TASK_ID)).toBe(true);

    // A task that restarts after completion is allowed to complete again.
    const restarted = run([
      done,
      {
        ev: "background_progress",
        session_id: NATIVE_SESSION_ID,
        task_id: NATIVE_TASK_ID,
        label: "Indexing",
        summary: "again",
      },
      done,
    ]);
    expect(restarted.events.map((event) => event.type)).toEqual([
      "task.completed",
      "task.started",
      "task.completed",
    ]);

    // Completion tracking is bounded like every other adapter-local map.
    const many = run(
      Array.from(
        { length: 300 },
        (_, index) =>
          ({
            ev: "background_progress",
            session_id: NATIVE_SESSION_ID,
            task_id: `task-${index}`,
            label: "Indexing",
            summary: "finished",
            done: true,
          }) as ApiEvent,
      ),
    );
    expect(many.state.completedTasks.size).toBeLessThanOrEqual(64);
  });

  it("maps known session statuses and demotes unknown strings to safe detail", () => {
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["idle", "idle"],
      ["ready", "idle"],
      ["running", "active"],
      ["busy", "active"],
      ["error", "error"],
      ["compacting", "active"],
    ];
    for (const [status, state] of rows) {
      const result = run([{ ev: "session_status", session_id: NATIVE_SESSION_ID, status }]);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        type: "thread.state.changed",
        payload: { state },
      });
      decodeAll(result.events);
    }

    const unknown = run([
      { ev: "session_status", session_id: NATIVE_SESSION_ID, status: "quantum-tunnelling" },
    ]);
    expect(unknown.events[0]).toMatchObject({
      type: "thread.state.changed",
      payload: { state: "active", detail: { status: "quantum-tunnelling" } },
    });

    const longStatus = run([
      { ev: "session_status", session_id: NATIVE_SESSION_ID, status: "z".repeat(9_000) },
    ]);
    const detail = (longStatus.events[0] as ThreadStateChanged).payload.detail as {
      readonly status: string;
    };
    expect(detail.status.length).toBeLessThanOrEqual(4_000);
    decodeAll(longStatus.events);
  });

  it("emits model.rerouted only when the observed model changes", () => {
    const first = mapJcodeRuntimeEvent(
      initialJcodeEventMappingState,
      { ev: "model_info", session_id: NATIVE_SESSION_ID, model: "sonnet" },
      context(),
    );
    expect(first.events).toEqual([]);
    expect(first.state.currentModel).toBe("sonnet");

    const same = mapJcodeRuntimeEvent(
      first.state,
      { ev: "model_info", session_id: NATIVE_SESSION_ID, model: "sonnet" },
      context(),
    );
    expect(same.events).toEqual([]);

    const changed = mapJcodeRuntimeEvent(
      first.state,
      { ev: "model_info", session_id: NATIVE_SESSION_ID, model: "opus" },
      context(),
    );
    expect(changed.events).toHaveLength(1);
    expect(changed.events[0]).toMatchObject({
      type: "model.rerouted",
      payload: { fromModel: "sonnet", toModel: "opus" },
    });
    expect(changed.state.currentModel).toBe("opus");
    decodeAll(changed.events);

    const missing = mapJcodeRuntimeEvent(
      first.state,
      { ev: "model_info", session_id: NATIVE_SESSION_ID },
      context(),
    );
    expect(missing.events).toEqual([]);
    expect(missing.state.currentModel).toBe("sonnet");
  });

  it("completes every open item before turn.completed and resets per-turn state", () => {
    const result = run([textDelta("hi"), reasoningDelta("hmm"), toolStart("bash"), turnDone()]);

    expect(result.events.map((event) => event.type)).toEqual([
      "item.started",
      "content.delta",
      "item.started",
      "content.delta",
      "item.started",
      "item.completed",
      "item.completed",
      "item.completed",
      "turn.completed",
    ]);
    const tail = result.events.slice(-4);
    expect(tail[0]).toMatchObject({
      payload: { itemType: "assistant_message", status: "completed" },
    });
    expect(tail[1]).toMatchObject({ payload: { itemType: "reasoning", status: "completed" } });
    expect(tail[2]).toMatchObject({
      itemId: TOOL_ITEM_ID,
      payload: { itemType: "command_execution", status: "failed" },
    });
    expect(tail[3]).toMatchObject({ type: "turn.completed", payload: { state: "completed" } });

    expect(result.state.assistantStarted).toBe(false);
    expect(result.state.reasoningStarted).toBe(false);
    expect(result.state.openTools.size).toBe(0);
    decodeAll(result.events);
  });

  it("emits only turn.completed when no items are open", () => {
    const result = run([turnDone()]);
    expect(result.events.map((event) => event.type)).toEqual(["turn.completed"]);
    expect(result.fatal).toBe(false);
    decodeAll(result.events);
  });

  // F4 regression: two complete segments under one Pylon turn must not reuse
  // assistant/reasoning item IDs, or one durable item gets two terminal rows.
  it("gives each turn_done segment distinct assistant and reasoning item ids", () => {
    const result = run([
      textDelta("first"),
      reasoningDelta("first"),
      turnDone(),
      textDelta("second"),
      reasoningDelta("second"),
      turnDone(),
    ]);

    const byType = (type: string) => result.events.filter((event) => event.type === type);
    expect(byType("turn.completed")).toHaveLength(2);

    const assistantIds = byType("item.started")
      .filter((event) => (event as ItemStarted).payload.itemType === "assistant_message")
      .map((event) => event.itemId);
    expect(assistantIds).toHaveLength(2);
    expect(new Set(assistantIds).size).toBe(2);

    const reasoningIds = byType("item.started")
      .filter((event) => (event as ItemStarted).payload.itemType === "reasoning")
      .map((event) => event.itemId);
    expect(new Set(reasoningIds).size).toBe(2);

    // Exactly one started/completed pair per item ID.
    for (const itemId of [...assistantIds, ...reasoningIds]) {
      expect(
        result.events.filter((event) => event.itemId === itemId && event.type === "item.started"),
      ).toHaveLength(1);
      expect(
        result.events.filter((event) => event.itemId === itemId && event.type === "item.completed"),
      ).toHaveLength(1);
    }

    expect(result.state.segment).toBe(2);
    decodeAll(result.events);
  });

  // F4 regression: the thread-keyed fallback must segment too, or the collision
  // becomes permanent for the whole thread.
  it("segments assistant item ids when no Pylon turn id is present", () => {
    const result = run([textDelta("a"), turnDone(), textDelta("b"), turnDone()], {
      turnId: undefined,
    });
    const startedIds = result.events
      .filter((event) => event.type === "item.started")
      .map((event) => event.itemId);
    expect(new Set(startedIds).size).toBe(2);
    for (const event of result.events) expect(event.turnId).toBeUndefined();
    decodeAll(result.events);
  });

  // F4 regression: segment identity is bounded, so it wraps rather than growing.
  it("wraps the segment counter instead of growing without bound", () => {
    const wrapped = run(
      [turnDone()],
      {},
      { ...initialJcodeEventMappingState, segment: MAX_TURN_SEGMENTS - 1 },
    );
    expect(wrapped.state.segment).toBe(0);
  });

  // F5 regression: an item.updated emitted without a preceding tool_start must
  // still be closed at turn_done.
  it("closes tool items opened by out-of-order input deltas", () => {
    const result = run([toolInputDelta('{"a":1}'), turnDone()]);

    expect(result.events.map((event) => event.type)).toEqual([
      "item.updated",
      "item.completed",
      "turn.completed",
    ]);
    expect(result.events[0]).toMatchObject({
      itemId: TOOL_ITEM_ID,
      payload: { itemType: "dynamic_tool_call", status: "inProgress" },
    });
    expect(result.events[1]).toMatchObject({ itemId: TOOL_ITEM_ID, payload: { status: "failed" } });
    expect(result.state.openTools.size).toBe(0);
    decodeAll(result.events);
  });

  // F5 regression: an open call evicted by the tracking cap must be closed at
  // eviction time, since turn_done can no longer see it.
  it("closes a tool item evicted by the tracking cap", () => {
    const overflow = MAX_TRACKED_TOOL_CALLS + 1;
    const result = run(
      Array.from({ length: overflow }, (_, index) => toolStart("bash", `call-${index}`)),
    );

    const evictedId = toolItemIdFor("call-0");
    const evictionRows = result.events.filter(
      (event) => event.type === "item.completed" && event.itemId === evictedId,
    );
    expect(evictionRows).toHaveLength(1);
    expect(evictionRows[0]).toMatchObject({ payload: { status: "failed" } });
    expect(result.state.openTools.size).toBe(MAX_TRACKED_TOOL_CALLS);
    expect(result.state.openTools.has("call-0")).toBe(false);
    decodeAll(result.events);

    // Nothing the mapper opened stays open once the turn ends.
    const closed = run([
      ...Array.from({ length: overflow }, (_, index) => toolStart("bash", `call-${index}`)),
      turnDone(),
    ]);
    const openedIds = new Set(
      closed.events
        .filter((event) => event.type === "item.started" || event.type === "item.updated")
        .map((event) => event.itemId),
    );
    const completedIds = new Set(
      closed.events.filter((event) => event.type === "item.completed").map((event) => event.itemId),
    );
    for (const itemId of openedIds) expect(completedIds.has(itemId)).toBe(true);
  });

  it("treats permission_request as a fatal runtime error and never auto-approves", () => {
    const result = run([
      {
        ev: "permission_request",
        session_id: NATIVE_SESSION_ID,
        request_id: NATIVE_REQUEST_ID,
        tool_name: "bash",
        description: "run rm -rf /",
      },
    ]);

    expect(result.fatal).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: "runtime.error",
      payload: { class: "permission_error" },
    });
    const serialized = JSON.stringify(result.events);
    expect(serialized).not.toContain(NATIVE_REQUEST_ID);
    expect(serialized).not.toContain("allow");
    decodeAll(result.events);
  });

  // F7: documented tolerance. A tool_done for a call this mapper never opened
  // still completes, because dropping it would leave a client that saw the
  // native start elsewhere with a row that never resolves.
  it("tolerantly completes a tool_done for a call it never opened", () => {
    const result = run([
      {
        ev: "tool_done",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        name: "bash",
        output: "ok",
      },
    ]);
    expect(result.events.map((event) => event.type)).toEqual(["item.completed"]);
    expect(result.events[0]).toMatchObject({
      itemId: TOOL_ITEM_ID,
      payload: { itemType: "command_execution", status: "completed" },
    });
    expect(result.state.openTools.size).toBe(0);
    decodeAll(result.events);
  });

  it("ignores message_accepted, SDK reply/admin kinds, and unknown future events", () => {
    const ignored: ReadonlyArray<ApiEvent> = [
      { ev: "message_accepted", session_id: NATIVE_SESSION_ID },
      { ev: "hello_ok", version: 1, server: "jcode", capabilities: [] },
      { ev: "ok" },
      { ev: "error", code: "invalid_request", message: "bad" },
      { ev: "sessions", sessions: [] },
      { ev: "attached", session: { session_id: NATIVE_SESSION_ID, status: "idle" } },
      { ev: "history", session_id: NATIVE_SESSION_ID, messages: [] },
      { ev: "pong" },
      { ev: "models", session_id: NATIVE_SESSION_ID, models: ["a"], current: "a" },
      { ev: "runtime_info", session_id: NATIVE_SESSION_ID, routes: [] },
      { ev: "credential_updated", provider: "anthropic", configured: true },
      {
        ev: "file_content",
        session_id: NATIVE_SESSION_ID,
        path: "/x",
        content: "y",
        size: 1,
        truncated: false,
      },
      { ev: "files", session_id: NATIVE_SESSION_ID, paths: [] },
      { ev: "text_matches", session_id: NATIVE_SESSION_ID, matches: [] },
      {
        ev: "file_status",
        session_id: NATIVE_SESSION_ID,
        path: "/x",
        exists: true,
        kind: "file",
      },
      { ev: "compacted", session_id: NATIVE_SESSION_ID, message: "compacted" },
      { ev: "session_renamed", session_id: NATIVE_SESSION_ID, display_title: "Title" },
      { ev: "future_unicorn_event", session_id: NATIVE_SESSION_ID } as unknown as ApiEvent,
    ];

    for (const event of ignored) {
      const result = mapJcodeRuntimeEvent(initialJcodeEventMappingState, event, context());
      expect(result.events, `expected ${event.ev} to be ignored`).toEqual([]);
      expect(result.fatal).toBe(false);
      expect(result.state).toBe(initialJcodeEventMappingState);
    }
  });

  it("does not treat compacted as turn completion even mid-turn", () => {
    const result = run([
      textDelta("hi"),
      { ev: "compacted", session_id: NATIVE_SESSION_ID, message: "compacted" },
    ]);
    expect(result.events.map((event) => event.type)).toEqual(["item.started", "content.delta"]);
    expect(result.state.assistantStarted).toBe(true);
  });

  it("stamps every emitted event uniquely and decodes through the canonical schema", () => {
    const result = run([
      textDelta("hi"),
      reasoningDelta("hmm"),
      toolStart("bash"),
      toolInputDelta("{}"),
      { ev: "tool_exec", session_id: NATIVE_SESSION_ID, call_id: NATIVE_CALL_ID, name: "bash" },
      {
        ev: "tool_done",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        name: "bash",
        output: "ok",
      },
      { ev: "token_usage", session_id: NATIVE_SESSION_ID, input: 5, output: 6 },
      {
        ev: "background_progress",
        session_id: NATIVE_SESSION_ID,
        task_id: NATIVE_TASK_ID,
        label: "Indexing",
        summary: "scanning",
      },
      { ev: "session_status", session_id: NATIVE_SESSION_ID, status: "running" },
      { ev: "model_info", session_id: NATIVE_SESSION_ID, model: "sonnet" },
      { ev: "model_info", session_id: NATIVE_SESSION_ID, model: "opus" },
      turnDone(),
    ]);

    expect(result.events.length).toBeGreaterThan(10);
    const eventIds = result.events.map((event) => event.eventId);
    expect(new Set(eventIds).size).toBe(eventIds.length);

    decodeAll(result.events);
    for (const event of result.events) {
      expect(event.provider).toBe("jcode");
      expect(event.providerInstanceId).toBe("jcode_local");
      expect(event.threadId).toBe("thread-1");
      expect(event.turnId).toBe("turn-1");
      expect(event.createdAt).toBe("2026-08-09T00:00:00.000Z");
      expect("raw" in event).toBe(false);
    }

    const serialized = JSON.stringify(result.events);
    for (const native of [NATIVE_SESSION_ID, NATIVE_CALL_ID, NATIVE_TASK_ID]) {
      expect(serialized).not.toContain(native);
    }
  });

  it("bounds streamed text, tool output, task labels, and task summaries", () => {
    const huge = "q".repeat(250_000);
    const result = run([
      textDelta(huge),
      toolStart("bash"),
      {
        ev: "tool_done",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        name: "bash",
        output: huge,
      },
      {
        ev: "background_progress",
        session_id: NATIVE_SESSION_ID,
        task_id: NATIVE_TASK_ID,
        label: huge,
        summary: huge,
      },
    ]);

    const delta = result.events.find((event) => event.type === "content.delta");
    expect((delta as ContentDelta).payload.delta.length).toBeLessThanOrEqual(100_000);

    const completed = result.events.find(
      (event) => event.type === "item.completed" && event.itemId === TOOL_ITEM_ID,
    );
    expect((completed as ItemCompleted).payload.detail?.length).toBeLessThanOrEqual(100_000);

    const started = result.events.find((event) => event.type === "task.started");
    expect((started as TaskStarted).payload.description?.length).toBeLessThanOrEqual(4_000);

    decodeAll(result.events);
  });

  it("omits the turn id when the mapper runs outside an active turn", () => {
    const result = run([textDelta("hi"), turnDone()], { turnId: undefined });
    for (const event of result.events) expect(event.turnId).toBeUndefined();
    decodeAll(result.events);
    expect(result.events.map((event) => event.type)).toEqual([
      "item.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
  });

  it("never mutates the state it is given", () => {
    const first = mapJcodeRuntimeEvent(initialJcodeEventMappingState, textDelta("hi"), context());
    expect(initialJcodeEventMappingState.assistantStarted).toBe(false);
    expect(first.state).not.toBe(initialJcodeEventMappingState);

    const tooled = mapJcodeRuntimeEvent(first.state, toolStart("bash"), context());
    expect(first.state.openTools.size).toBe(0);
    expect(tooled.state.openTools.size).toBe(1);
  });
});
