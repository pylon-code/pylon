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
  initialJcodeEventMappingState,
  mapJcodeRuntimeEvent,
  type JcodeEventMappingContext,
  type JcodeEventMappingState,
} from "./JcodeRuntimeEvents.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

const NATIVE_SESSION_ID = "native-session-abc";
const NATIVE_CALL_ID = "native-call-abc";
const NATIVE_TASK_ID = "native-task-abc";
const NATIVE_REQUEST_ID = "native-request-abc";

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

/** Folds a whole SDK event sequence the way the session runtime will. */
function run(
  events: ReadonlyArray<ApiEvent>,
  overrides: Partial<JcodeEventMappingContext> = {},
): {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly state: JcodeEventMappingState;
  readonly fatal: boolean;
} {
  let state = initialJcodeEventMappingState;
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
const turnDone = (): ApiEvent => ({ ev: "turn_done", session_id: NATIVE_SESSION_ID });

const TOOL_ITEM_ID = `jcode-tool:${Buffer.from(NATIVE_CALL_ID, "utf8").toString("base64url")}`;
const TASK_ID = `jcode-task:${Buffer.from(NATIVE_TASK_ID, "utf8").toString("base64url")}`;

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
    }

    const longName = "x".repeat(10_000);
    const bounded = run([toolStart(longName)]).events[0];
    expect(
      (bounded as Extract<ProviderRuntimeEvent, { type: "item.started" }>).payload.title?.length,
    ).toBeLessThanOrEqual(4_000);
  });

  it("parses accumulated tool input only when the whole value is valid JSON", () => {
    const partial = run([
      toolStart("bash"),
      {
        ev: "tool_input_delta",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        delta: '{"command":',
      },
    ]);
    const partialUpdate = partial.events.at(-1);
    expect(partialUpdate).toMatchObject({
      type: "item.updated",
      itemId: TOOL_ITEM_ID,
      payload: { itemType: "command_execution", status: "inProgress" },
    });
    expect(
      (partialUpdate as Extract<ProviderRuntimeEvent, { type: "item.updated" }>).payload.data,
    ).toEqual({ input: '{"command":' });
    expect(partial.state.toolInputs.get(NATIVE_CALL_ID)).toBe('{"command":');

    const complete = run([
      toolStart("bash"),
      {
        ev: "tool_input_delta",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        delta: '{"command":',
      },
      {
        ev: "tool_input_delta",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        delta: '"ls -la"}',
      },
    ]);
    expect(
      (complete.events.at(-1) as Extract<ProviderRuntimeEvent, { type: "item.updated" }>).payload
        .data,
    ).toEqual({ command: "ls -la" });
  });

  it("bounds accumulated tool input and the number of tracked calls", () => {
    const chunk = "a".repeat(5_000);
    const result = run([
      toolStart("bash"),
      {
        ev: "tool_input_delta",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        delta: chunk,
      },
      {
        ev: "tool_input_delta",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        delta: chunk,
      },
      {
        ev: "tool_input_delta",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        delta: chunk,
      },
    ]);
    expect(result.state.toolInputs.get(NATIVE_CALL_ID)?.length).toBeLessThanOrEqual(8_000);

    const manyCalls = Array.from({ length: 300 }, (_, index) => toolStart("bash", `call-${index}`));
    expect(run(manyCalls).state.toolInputs.size).toBeLessThanOrEqual(64);
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
    expect(ok.state.toolInputs.size).toBe(0);

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
        usage: {
          usedTokens: 150,
          inputTokens: 120,
          outputTokens: 30,
          cachedInputTokens: 90,
        },
      },
    });
  });

  it("ignores token usage with non-integer or negative counters", () => {
    expect(
      run([{ ev: "token_usage", session_id: NATIVE_SESSION_ID, input: -1, output: 3 }]).events,
    ).toEqual([]);
    expect(
      run([{ ev: "token_usage", session_id: NATIVE_SESSION_ID, input: 1.5, output: 3 }]).events,
    ).toEqual([]);
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
    const detail = (
      longStatus.events[0] as Extract<ProviderRuntimeEvent, { type: "thread.state.changed" }>
    ).payload.detail as { readonly status: string };
    expect(detail.status.length).toBeLessThanOrEqual(4_000);
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

    const missing = mapJcodeRuntimeEvent(
      first.state,
      { ev: "model_info", session_id: NATIVE_SESSION_ID },
      context(),
    );
    expect(missing.events).toEqual([]);
    expect(missing.state.currentModel).toBe("sonnet");
  });

  it("completes every open item before turn.completed and resets turn state", () => {
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

    expect(result.state).toEqual(initialJcodeEventMappingState);
  });

  it("emits only turn.completed when no items are open", () => {
    const result = run([turnDone()]);
    expect(result.events.map((event) => event.type)).toEqual(["turn.completed"]);
    expect(result.fatal).toBe(false);
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
      {
        ev: "tool_input_delta",
        session_id: NATIVE_SESSION_ID,
        call_id: NATIVE_CALL_ID,
        delta: "{}",
      },
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

    for (const event of result.events) {
      expect(() => decodeRuntimeEvent(event)).not.toThrow();
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
    expect(
      (delta as Extract<ProviderRuntimeEvent, { type: "content.delta" }>).payload.delta.length,
    ).toBeLessThanOrEqual(100_000);

    const completed = result.events.find(
      (event) => event.type === "item.completed" && event.itemId === TOOL_ITEM_ID,
    );
    expect(
      (completed as Extract<ProviderRuntimeEvent, { type: "item.completed" }>).payload.detail
        ?.length,
    ).toBeLessThanOrEqual(100_000);

    const started = result.events.find((event) => event.type === "task.started");
    const payload = (started as Extract<ProviderRuntimeEvent, { type: "task.started" }>).payload;
    expect(payload.description?.length).toBeLessThanOrEqual(4_000);

    for (const event of result.events) {
      expect(() => decodeRuntimeEvent(event)).not.toThrow();
    }
  });

  it("omits the turn id when the mapper runs outside an active turn", () => {
    const result = run([textDelta("hi"), turnDone()], { turnId: undefined });
    for (const event of result.events) {
      expect(event.turnId).toBeUndefined();
      expect(() => decodeRuntimeEvent(event)).not.toThrow();
    }
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
    expect(first.state.toolInputs.size).toBe(0);
    expect(tooled.state.toolInputs.size).toBe(1);
  });
});
