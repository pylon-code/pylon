// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  codexConversationDigest,
  forkCodexConversation,
  readCodexConversation,
  type CodexConversationSnapshot,
} from "./CodexAbsoluteHistory.ts";

const CWD = "/tmp/codex-history-test";
const decodeRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    threadId: Schema.String,
    includeTurns: Schema.optionalKey(Schema.Boolean),
    lastTurnId: Schema.optionalKey(Schema.String),
    cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);
const decodeTurnId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }));
const decodeNativeObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));
const decodeThreadRecord = Schema.decodeUnknownSync(
  Schema.Struct({
    thread: Schema.Record(Schema.String, Schema.Unknown),
    cwd: Schema.optionalKey(Schema.String),
  }),
);

function turn(id: string, overrides: Schema.JsonObject = {}): Schema.Json {
  return {
    id,
    status: "completed",
    itemsView: "full",
    completedAt: 123,
    error: null,
    items: [
      { id: `${id}-user`, type: "userMessage", content: [{ type: "text", text: "same prompt" }] },
    ],
    ...overrides,
  };
}

interface MockThread {
  turns: ReadonlyArray<Schema.Json>;
  nativeRecords?: ReadonlyArray<Schema.JsonObject>;
  nativeGoal?: Schema.JsonObject | null;
  paginated?: boolean;
  forkedFromId?: string;
}

const nativeRecord = (type: string, payload: Schema.JsonObject): Schema.JsonObject => ({
  timestamp: "2026-01-01T00:00:00.000Z",
  type,
  payload,
});
const nativeSession = (id: string, forkedFromId?: string): Schema.JsonObject =>
  nativeRecord("session_meta", {
    id,
    session_id: id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: CWD,
    context_window: { window_id: `window-${id}` },
    base_instructions: { text: "native system instructions" },
    ...(forkedFromId ? { forked_from_id: forkedFromId } : {}),
  });
const nativeHistory = (id: string, turns: ReadonlyArray<Schema.Json>): Array<Schema.JsonObject> => [
  nativeSession(id),
  ...turns.flatMap((raw) => {
    const { id: turnId } = decodeTurnId(raw);
    return [
      nativeRecord("event_msg", { type: "task_started", turn_id: turnId }),
      nativeRecord("turn_context", {
        turn_id: turnId,
        cwd: CWD,
        developer_instructions: "native developer instructions",
      }),
      nativeRecord("response_item", {
        type: "message",
        id: `${turnId}-user`,
        role: "user",
        content: [{ type: "input_text", text: "same prompt" }],
      }),
      nativeRecord("event_msg", { type: "task_complete", turn_id: turnId }),
    ];
  }),
];
const rawNativeRecords = (id: string, thread: MockThread) =>
  thread.nativeRecords ?? nativeHistory(id, thread.turns);

function makeClient(initialTurns: ReadonlyArray<Schema.Json> = [turn("turn-1"), turn("turn-2")]) {
  const threads = new Map<string, MockThread>([
    ["source", { turns: structuredClone(initialTurns) }],
  ]);
  const calls: Array<{ method: string; params: unknown }> = [];
  let forkCount = 0;
  const hooks: {
    rollout?: (path: string, text: string) => string;
    response?: (
      method: string,
      params: ReturnType<typeof decodeRequest>,
      response: unknown,
    ) => unknown;
  } = {};
  const client: Parameters<typeof readCodexConversation>[0] = {
    readRollout: (path) =>
      Effect.sync(() => {
        const id = path
          .split("/")
          .at(-1)
          ?.replace(/\.jsonl$/, "");
        const thread = id === undefined ? undefined : threads.get(id);
        NodeAssert.ok(thread && id);
        const text = `${rawNativeRecords(id, thread)
          .map((record) => JSON.stringify(record))
          .join("\n")}\n`;
        return hooks.rollout?.(path, text) ?? text;
      }),
    raw: {
      request: (method, params) =>
        Effect.sync(() => {
          calls.push({ method, params });
          const request = decodeRequest(params);
          const source = threads.get(request.threadId);
          NodeAssert.ok(source, `Unknown thread ${request.threadId}`);
          const metadata = (id: string, thread: MockThread, includeTurns: boolean) => ({
            thread: {
              id,
              cwd: CWD,
              path: `${CWD}/${id}.jsonl`,
              ephemeral: false,
              status: { type: "idle" },
              ...(thread.paginated ? { historyMode: "paginated" } : {}),
              ...(thread.forkedFromId ? { forkedFromId: thread.forkedFromId } : {}),
              turns: includeTurns ? thread.turns : [],
            },
          });
          let response: unknown;
          if (method === "thread/goal/get") {
            response = { goal: source.nativeGoal ?? null };
          } else if (method === "thread/read") {
            response = metadata(request.threadId, source, request.includeTurns === true);
          } else if (method === "thread/turns/list") {
            const start = request.cursor == null ? 0 : Number(request.cursor);
            response = {
              data: source.turns.slice(start, start + 1),
              nextCursor: start + 1 < source.turns.length ? String(start + 1) : null,
            };
          } else if (method === "thread/fork") {
            const count =
              request.lastTurnId === undefined
                ? source.turns.length
                : source.turns.findIndex((item) => decodeTurnId(item).id === request.lastTurnId) +
                  1;
            const forked: MockThread = {
              turns: structuredClone(source.turns.slice(0, count)),
              ...(source.paginated ? { paginated: true } : {}),
              forkedFromId: request.threadId,
            };
            const forkId = `fork-${++forkCount}`;
            forked.nativeGoal = source.nativeGoal
              ? { ...source.nativeGoal, threadId: forkId }
              : null;
            const native = rawNativeRecords(request.threadId, source);
            const turnStart = native.findIndex((record) => {
              const payload = record.payload;
              return (
                typeof payload === "object" &&
                payload !== null &&
                "type" in payload &&
                payload.type === "task_started" &&
                "turn_id" in payload &&
                payload.turn_id === request.lastTurnId
              );
            });
            const nextStart =
              request.lastTurnId === undefined
                ? -1
                : native.findIndex((record, index) => {
                    const payload = record.payload;
                    return (
                      index > turnStart &&
                      typeof payload === "object" &&
                      payload !== null &&
                      "type" in payload &&
                      payload.type === "task_started"
                    );
                  });
            forked.nativeRecords = [
              nativeSession(forkId, request.threadId),
              ...native.slice(0, nextStart < 0 ? undefined : nextStart),
            ].map((record, ordinal) => ({
              ...record,
              ordinal,
              timestamp: "2026-01-02T00:00:00.000Z",
            }));
            threads.set(forkId, forked);
            response = {
              ...metadata(forkId, forked, !forked.paginated),
              cwd: CWD,
              model: "codex-test",
            };
          } else {
            NodeAssert.fail(`Unexpected mutation or request ${method}`);
          }
          const isolatedResponse: unknown = structuredClone(response);
          return hooks.response?.(method, request, isolatedResponse) ?? isolatedResponse;
        }),
    },
  };
  return { client, calls, threads, hooks };
}

const readSource = (client: Parameters<typeof readCodexConversation>[0]) =>
  readCodexConversation(client, "source", CWD);

function replaceThread(response: unknown, update: Record<string, unknown>) {
  const decoded = decodeThreadRecord(response);
  return { ...decoded, thread: { ...decoded.thread, ...update } };
}

describe("codexConversationDigest", () => {
  it("ignores enclosing identity and key order while retaining the entire native history", () => {
    const first: CodexConversationSnapshot = {
      threadId: "source",
      cwd: CWD,
      rolloutPath: `${CWD}/source.jsonl`,
      nativeRecords: [nativeRecord("compacted", { replacement_history: [] })],
      nativeGoal: null,
      turns: [{ id: "one", unknown: { b: 2, a: 1 }, items: [], status: "completed" }],
    };
    NodeAssert.equal(
      codexConversationDigest(first),
      codexConversationDigest({
        threadId: "fork",
        cwd: CWD,
        rolloutPath: `${CWD}/fork.jsonl`,
        nativeRecords: first.nativeRecords,
        nativeGoal: null,
        turns: [{ status: "completed", items: [], unknown: { a: 1, b: 2 }, id: "one" }],
      }),
    );
    for (const changed of [
      { ...first, cwd: "/tmp/other" },
      {
        ...first,
        turns: [{ id: "different", unknown: { a: 1, b: 2 }, items: [], status: "completed" }],
      },
      { ...first, turns: [{ id: "one", unknown: { a: 1, b: 3 }, items: [], status: "completed" }] },
      { ...first, turns: [{ id: "one", unknown: { a: 1, b: 2 }, items: [], status: "failed" }] },
    ])
      NodeAssert.notEqual(codexConversationDigest(first), codexConversationDigest(changed));
  });
});

describe("readCodexConversation", () => {
  it.effect("preserves unknown turn and item fields, error details, and relationships", () =>
    Effect.gen(function* () {
      const turns = [
        turn("turn-1", {
          providerExtension: { callId: "call-1" },
          items: [
            { id: "item-1", type: "futureTool", sourceId: "item-0", result: { rich: [1, "two"] } },
          ],
        }),
        turn("turn-2", {
          status: "failed",
          error: { message: "failed", futureDetail: { causeId: "item-1" } },
        }),
      ];
      const { client } = makeClient(turns);
      NodeAssert.deepEqual((yield* readSource(client)).turns, turns);
    }),
  );

  it.effect("reads paginated history in order with full items and rechecks idle metadata", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      fixture.threads.set("source", { turns: [turn("turn-1"), turn("turn-2")], paginated: true });
      const snapshot = yield* readSource(fixture.client);
      NodeAssert.deepEqual(snapshot.turns, [turn("turn-1"), turn("turn-2")]);
      NodeAssert.deepEqual(
        fixture.calls
          .filter((call) => call.method === "thread/turns/list")
          .map((call) => call.params),
        [
          { threadId: "source", cursor: null, limit: 100, sortDirection: "asc", itemsView: "full" },
          { threadId: "source", cursor: "1", limit: 100, sortDirection: "asc", itemsView: "full" },
        ],
      );
      NodeAssert.equal(fixture.calls.filter((call) => call.method === "thread/read").length, 2);
    }),
  );

  for (const update of [
    { id: "foreign" },
    { cwd: "/tmp/foreign" },
    { ephemeral: true },
    { status: { type: "active", activeFlags: [] } },
    { status: { type: "systemError" } },
    { historyMode: "unknown" },
  ]) {
    it.effect(`rejects unverified metadata ${JSON.stringify(update)}`, () =>
      Effect.gen(function* () {
        const fixture = makeClient();
        fixture.hooks.response = (_method, _params, response) => replaceThread(response, update);
        NodeAssert.equal(
          (yield* Effect.flip(readSource(fixture.client)))._tag,
          "CodexAppServerRequestError",
        );
      }),
    );
  }

  for (const turns of [
    [turn("one", { status: "inProgress" })],
    [turn("one", { itemsView: "summary" })],
    [turn("one", { itemsView: "notLoaded" })],
    [turn("one"), turn("one")],
    [{ id: "one", status: "completed" }],
    [turn("one", { items: [{ type: "agentMessage", text: "missing id" }] })],
    [
      turn("one", {
        items: [
          { id: "same", type: "plan" },
          { id: "same", type: "plan" },
        ],
      }),
    ],
  ]) {
    it.effect(`rejects incomplete or ambiguous history ${JSON.stringify(turns)}`, () =>
      Effect.gen(function* () {
        const { client } = makeClient(turns);
        NodeAssert.equal(
          (yield* Effect.flip(readSource(client)))._tag,
          "CodexAppServerRequestError",
        );
      }),
    );
  }

  it.effect("rejects pagination cycles before requesting the same page again", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      fixture.threads.set("source", { turns: [], paginated: true });
      fixture.hooks.response = (method, _params, response) =>
        method === "thread/turns/list" ? { data: [], nextCursor: "cycle" } : response;
      NodeAssert.match(
        (yield* Effect.flip(readSource(fixture.client))).message,
        /repeated a cursor/,
      );
      NodeAssert.equal(
        fixture.calls.filter((call) => call.method === "thread/turns/list").length,
        2,
      );
    }),
  );

  it.effect("rejects a conversation that starts running during pagination", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      fixture.threads.set("source", { turns: [], paginated: true });
      let readCount = 0;
      fixture.hooks.response = (method, _params, response) =>
        method === "thread/read" && ++readCount === 2
          ? replaceThread(response, { status: { type: "active", activeFlags: [] } })
          : response;
      NodeAssert.match(
        (yield* Effect.flip(readSource(fixture.client))).message,
        /persistent and idle/,
      );
    }),
  );
});

describe("forkCodexConversation", () => {
  it.effect("passes captured configuration while preventing source or boundary overrides", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      const source = yield* readSource(fixture.client);
      yield* forkCodexConversation(
        {
          ...fixture.client,
          forkOptions: {
            model: "captured-model",
            serviceTier: "fast",
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            threadId: "foreign",
            cwd: "/tmp/foreign",
            ephemeral: true,
            deferGoalContinuation: false,
            path: "/tmp/foreign.jsonl",
            lastTurnId: "turn-1",
            beforeTurnId: "turn-1",
          },
        },
        { source },
      );
      NodeAssert.deepEqual(fixture.calls.find((call) => call.method === "thread/fork")?.params, {
        model: "captured-model",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        threadId: "source",
        cwd: CWD,
        ephemeral: false,
        deferGoalContinuation: true,
      });
    }),
  );
  it.effect(
    "forks through the exact completed identity inclusively and leaves the source unchanged",
    () =>
      Effect.gen(function* () {
        const fixture = makeClient();
        const source = yield* readSource(fixture.client);
        const fork = yield* forkCodexConversation(fixture.client, { source, lastTurnId: "turn-1" });
        NodeAssert.equal(fork.threadId, "fork-1");
        NodeAssert.equal(fork.cwd, CWD);
        NodeAssert.deepEqual(fork.turns, [turn("turn-1")]);
        NodeAssert.equal(fork.rolloutPath, `${CWD}/fork-1.jsonl`);
        NodeAssert.deepEqual(fixture.calls.find((call) => call.method === "thread/fork")?.params, {
          threadId: "source",
          lastTurnId: "turn-1",
          cwd: CWD,
          ephemeral: false,
          deferGoalContinuation: true,
        });
        NodeAssert.deepEqual((yield* readSource(fixture.client)).turns, source.turns);
      }),
  );

  it.effect(
    "reapplying the same snapshot creates fresh forks with identical semantic history",
    () =>
      Effect.gen(function* () {
        const fixture = makeClient();
        const source = yield* readSource(fixture.client);
        const first = yield* forkCodexConversation(fixture.client, { source });
        const second = yield* forkCodexConversation(fixture.client, { source });
        NodeAssert.notEqual(first.threadId, second.threadId);
        NodeAssert.equal(codexConversationDigest(first), codexConversationDigest(second));
        NodeAssert.equal(codexConversationDigest(first), codexConversationDigest(source));
      }),
  );

  it.effect("forks an already empty root without treating an omitted boundary as deletion", () =>
    Effect.gen(function* () {
      const fixture = makeClient([]);
      const source = yield* readSource(fixture.client);
      NodeAssert.deepEqual((yield* forkCodexConversation(fixture.client, { source })).turns, []);
      NodeAssert.deepEqual(fixture.calls.find((call) => call.method === "thread/fork")?.params, {
        threadId: "source",
        cwd: CWD,
        ephemeral: false,
        deferGoalContinuation: true,
      });
    }),
  );

  for (const boundary of ["missing", "failed", "interrupted"]) {
    it.effect(`rejects the non-completed boundary ${boundary} before issuing a fork`, () =>
      Effect.gen(function* () {
        const fixture = makeClient([
          turn("completed"),
          turn("failed", { status: "failed" }),
          turn("interrupted", { status: "interrupted" }),
        ]);
        const source = yield* readSource(fixture.client);
        NodeAssert.match(
          (yield* Effect.flip(
            forkCodexConversation(fixture.client, { source, lastTurnId: boundary }),
          )).message,
          /exact completed turn/,
        );
        NodeAssert.equal(
          fixture.calls.some((call) => call.method === "thread/fork"),
          false,
        );
      }),
    );
  }

  for (const update of [
    { id: "source" },
    { forkedFromId: "foreign" },
    { cwd: "/tmp/other" },
    { ephemeral: true },
    { status: { type: "active", activeFlags: [] } },
    { status: { type: "notLoaded" } },
  ]) {
    it.effect(`rejects fork metadata ${JSON.stringify(update)}`, () =>
      Effect.gen(function* () {
        const fixture = makeClient();
        const source = yield* readSource(fixture.client);
        fixture.hooks.response = (method, _params, response) =>
          method === "thread/fork" ? replaceThread(response, update) : response;
        NodeAssert.equal(
          (yield* Effect.flip(forkCodexConversation(fixture.client, { source })))._tag,
          "CodexAppServerRequestError",
        );
      }),
    );
  }

  for (const changed of [
    [turn("renamed"), turn("turn-2")],
    [
      turn("turn-1", {
        items: [
          {
            id: "renamed-item",
            type: "userMessage",
            content: [{ type: "text", text: "same prompt" }],
          },
        ],
      }),
      turn("turn-2"),
    ],
    [
      turn("turn-1", {
        items: [
          {
            id: "turn-1-user",
            type: "userMessage",
            content: [{ type: "text", text: "changed prompt" }],
          },
        ],
      }),
      turn("turn-2"),
    ],
    [turn("turn-2"), turn("turn-1")],
    [turn("turn-1", { futureRelationship: "foreign-item" }), turn("turn-2")],
  ]) {
    it.effect(`rejects equal-length fork history changes ${JSON.stringify(changed)}`, () =>
      Effect.gen(function* () {
        const fixture = makeClient();
        const source = yield* readSource(fixture.client);
        fixture.hooks.response = (method, _params, response) =>
          method === "thread/fork" ? replaceThread(response, { turns: changed }) : response;
        NodeAssert.match(
          (yield* Effect.flip(forkCodexConversation(fixture.client, { source }))).message,
          /changed retained history/,
        );
      }),
    );
  }

  it.effect("does not trust a correct fork response when rereading reveals different history", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      const source = yield* readSource(fixture.client);
      fixture.hooks.response = (method, params, response) =>
        method === "thread/read" && params.threadId === "fork-1" && params.includeTurns
          ? replaceThread(response, { turns: [turn("foreign"), turn("turn-2")] })
          : response;
      NodeAssert.match(
        (yield* Effect.flip(forkCodexConversation(fixture.client, { source }))).message,
        /changed retained turn content or identities/,
      );
    }),
  );

  it.effect("rejects a source changed since capture before creating a fork", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      const source = yield* readSource(fixture.client);
      fixture.threads.set("source", { turns: [turn("turn-1"), turn("turn-2"), turn("turn-3")] });
      NodeAssert.match(
        (yield* Effect.flip(forkCodexConversation(fixture.client, { source }))).message,
        /source changed after capture/,
      );
      NodeAssert.equal(
        fixture.calls.some((call) => call.method === "thread/fork"),
        false,
      );
    }),
  );

  it.effect("rejects a source changed during fork verification", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      const source = yield* readSource(fixture.client);
      fixture.hooks.response = (method, _params, response) => {
        if (method === "thread/fork")
          fixture.threads.set("source", {
            turns: [turn("turn-1"), turn("turn-2"), turn("turn-3")],
          });
        return response;
      };
      NodeAssert.match(
        (yield* Effect.flip(forkCodexConversation(fixture.client, { source }))).message,
        /source changed during fork verification/,
      );
    }),
  );

  it.effect("verifies paginated forks using full history despite empty response turns", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      fixture.threads.set("source", { turns: [turn("turn-1"), turn("turn-2")], paginated: true });
      const source = yield* readSource(fixture.client);
      const fork = yield* forkCodexConversation(fixture.client, { source, lastTurnId: "turn-1" });
      NodeAssert.deepEqual(fork.turns, [turn("turn-1")]);
    }),
  );
});

describe("native conversation proof", () => {
  const hiddenContexts = [
    nativeRecord("compacted", {
      replacement_history: [
        { type: "message", role: "developer", content: "retained native memory" },
      ],
      window_number: 2,
    }),
    nativeRecord("turn_context", {
      turn_id: "turn-2",
      model: "codex",
      developer_instructions: "retained native instructions",
      future: { enabled: true },
    }),
    nativeRecord("world_state", {
      full: true,
      state: { files: { "private.txt": "native baseline" } },
    }),
    nativeRecord("inter_agent_communication", {
      sender_thread_id: "child-1",
      receiver_thread_id: "source",
      trigger_turn: false,
      content: "native child message",
    }),
    nativeRecord("future_native_context", {
      relationships: ["item-1", "child-1"],
      inference: { hidden: "future context" },
    }),
  ];

  it.effect("reads unloaded persistent snapshots after restart without resuming them", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      fixture.hooks.response = (method, _params, response) =>
        method === "thread/read"
          ? replaceThread(response, { status: { type: "notLoaded" } })
          : response;
      const source = yield* readSource(fixture.client);
      NodeAssert.equal(source.turns.length, 2);
      NodeAssert.equal(
        fixture.calls.some((call) => call.method === "thread/resume"),
        false,
      );
      NodeAssert.match(
        (yield* Effect.flip(
          readCodexConversation(fixture.client, "source", CWD, { requireLoaded: true }),
        )).message,
        /persistent and idle/,
      );
    }),
  );

  it.effect("accepts regenerated native Git metadata but retains unknown Git context", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      const source = yield* readSource(fixture.client);
      fixture.hooks.response = (method, _params, response) => {
        if (method === "thread/fork") {
          const fork = fixture.threads.get("fork-1")!;
          const header = nativeSession("fork-1", "source");
          const payload = decodeNativeObject(header.payload);
          fork.nativeRecords = [
            {
              ...header,
              payload: {
                ...payload,
                git: { commit_hash: "new-checkout", branch: "restored", repository_url: "example" },
              },
            },
            ...fork.nativeRecords!.slice(1),
          ];
        }
        return response;
      };
      NodeAssert.equal(
        codexConversationDigest(yield* forkCodexConversation(fixture.client, { source })),
        codexConversationDigest(source),
      );
      fixture.hooks.rollout = (path, text) =>
        path.endsWith("fork-2.jsonl")
          ? text.replace('"context_window":', '"git":{"futureContext":"changed"},"context_window":')
          : text;
      delete fixture.hooks.response;
      NodeAssert.match(
        (yield* Effect.flip(forkCodexConversation(fixture.client, { source }))).message,
        /changed retained turn content or identities/,
      );
    }),
  );

  for (const hidden of hiddenContexts) {
    it.effect(`includes ${String(hidden.type)} context omitted by the public transcript`, () =>
      Effect.gen(function* () {
        const fixture = makeClient();
        const sourceThread = fixture.threads.get("source")!;
        sourceThread.nativeRecords = [...nativeHistory("source", sourceThread.turns), hidden];
        const source = yield* readSource(fixture.client);
        const forked = yield* forkCodexConversation(fixture.client, { source });
        NodeAssert.equal(codexConversationDigest(forked), codexConversationDigest(source));
        NodeAssert.deepEqual(forked.nativeRecords.at(-1), {
          type: hidden.type,
          payload: hidden.payload,
        });
        fixture.hooks.response = (method, _params, response) => {
          if (method === "thread/fork") {
            const fork = fixture.threads.get("fork-2")!;
            fork.nativeRecords = [
              ...fork.nativeRecords!.slice(0, -1),
              nativeRecord(String(hidden.type), { changedInference: "same public transcript" }),
            ];
          }
          return response;
        };
        NodeAssert.match(
          (yield* Effect.flip(forkCodexConversation(fixture.client, { source }))).message,
          /changed retained turn content or identities/,
        );
      }),
    );
  }

  it.effect(
    "retains opaque records after the terminal event through the exact next native start",
    () =>
      Effect.gen(function* () {
        const fixture = makeClient();
        const sourceThread = fixture.threads.get("source")!;
        const native = nativeHistory("source", sourceThread.turns);
        const interturn = nativeRecord("world_state", {
          full: false,
          state: { retainedBetweenTurns: true },
        });
        sourceThread.nativeRecords = [...native.slice(0, 5), interturn, ...native.slice(5)];
        const source = yield* readSource(fixture.client);
        const fork = yield* forkCodexConversation(fixture.client, { source, lastTurnId: "turn-1" });
        NodeAssert.deepEqual(fork.nativeRecords.at(-1), {
          type: interturn.type,
          payload: interturn.payload,
        });
        NodeAssert.deepEqual(fork.turns, [turn("turn-1")]);
      }),
  );

  it.effect("does not infer a native boundary from synthetic public turn identities", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      fixture.threads.get("source")!.nativeRecords = [nativeSession("source")];
      const source = yield* readSource(fixture.client);
      NodeAssert.match(
        (yield* Effect.flip(
          forkCodexConversation(fixture.client, { source, lastTurnId: "turn-1" }),
        )).message,
        /native boundary/,
      );
      NodeAssert.equal(
        fixture.calls.some((call) => call.method === "thread/fork"),
        false,
      );
    }),
  );

  it.effect("detects native-only source edits before creating a private fork", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      const source = yield* readSource(fixture.client);
      fixture.threads.get("source")!.nativeRecords = [
        ...nativeHistory("source", source.turns),
        hiddenContexts[0]!,
      ];
      NodeAssert.match(
        (yield* Effect.flip(forkCodexConversation(fixture.client, { source }))).message,
        /source changed after capture/,
      );
      NodeAssert.equal(
        fixture.calls.some((call) => call.method === "thread/fork"),
        false,
      );
    }),
  );

  it.effect("detects native-only source edits made while forking", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      const source = yield* readSource(fixture.client);
      fixture.hooks.response = (method, _params, response) => {
        if (method === "thread/fork")
          fixture.threads.get("source")!.nativeRecords = [
            ...nativeHistory("source", source.turns),
            hiddenContexts[0]!,
          ];
        return response;
      };
      NodeAssert.match(
        (yield* Effect.flip(forkCodexConversation(fixture.client, { source }))).message,
        /source changed during fork verification/,
      );
    }),
  );

  it.effect("detects a native file changing across the public history read", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      let reads = 0;
      fixture.hooks.rollout = (_path, text) =>
        ++reads === 1 ? text : `${text}${JSON.stringify(hiddenContexts[0])}\n`;
      NodeAssert.match(
        (yield* Effect.flip(readSource(fixture.client))).message,
        /native history changed while reading/,
      );
    }),
  );

  for (const metadata of [
    { id: "foreign" },
    { cwd: "/tmp/foreign" },
    { history_base: { thread_id: "unread-base", end_ordinal_exclusive: 4, end_byte_offset: 100 } },
    { context_window: { window_id: 7 } },
  ])
    it.effect(`rejects unprovable native session metadata ${JSON.stringify(metadata)}`, () =>
      Effect.gen(function* () {
        const fixture = makeClient();
        fixture.threads.get("source")!.nativeRecords = [
          nativeRecord("session_meta", {
            id: "source",
            session_id: "source",
            timestamp: "2026-01-01T00:00:00.000Z",
            cwd: CWD,
            ...metadata,
          }),
        ];
        NodeAssert.equal(
          (yield* Effect.flip(readSource(fixture.client)))._tag,
          "CodexAppServerRequestError",
        );
      }),
    );

  it.effect("fails closed without a provider-owned rollout reader", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      NodeAssert.match(
        (yield* Effect.flip(readSource({ raw: fixture.client.raw }))).message,
        /proof is unavailable/,
      );
    }),
  );

  for (const path of [null, "relative.jsonl", "", "/tmp/invalid\0.jsonl"])
    it.effect(`rejects native path ${JSON.stringify(path)}`, () =>
      Effect.gen(function* () {
        const fixture = makeClient();
        fixture.hooks.response = (method, _params, response) =>
          method === "thread/read" ? replaceThread(response, { path }) : response;
        NodeAssert.match(
          (yield* Effect.flip(readSource(fixture.client))).message,
          /proof is unavailable/,
        );
      }),
    );

  for (const [label, invalid] of [
    ["truncated", '{"type":"session_meta"}'],
    ["malformed", "not JSON\n"],
    ["empty", "\n"],
    ["missing envelope", "{}\n"],
    ["oversized line", `${" ".repeat(1024 * 1024 + 1)}\n`],
    ["oversized file", `${" ".repeat(16 * 1024 * 1024)}\n`],
    ["too many records", "{}\n".repeat(100_001)],
  ])
    it.effect(`rejects ${label} native JSONL without disclosing content`, () =>
      Effect.gen(function* () {
        const fixture = makeClient();
        fixture.hooks.rollout = () => invalid!;
        const error = yield* Effect.flip(readSource(fixture.client));
        NodeAssert.equal(error._tag, "CodexAppServerRequestError");
        NodeAssert.doesNotMatch(error.message, /native system instructions|retained native memory/);
      }),
    );

  it.effect("preserves unknown header context instead of treating it as generated identity", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      const source = yield* readSource(fixture.client);
      fixture.hooks.response = (method, _params, response) => {
        if (method === "thread/fork") {
          const fork = fixture.threads.get("fork-1")!;
          const first = fork.nativeRecords![0]!;
          fork.nativeRecords = [
            { ...first, providerInferenceExtension: { changed: true } },
            ...fork.nativeRecords!.slice(1),
          ];
        }
        return response;
      };
      NodeAssert.match(
        (yield* Effect.flip(forkCodexConversation(fixture.client, { source }))).message,
        /changed retained turn content or identities/,
      );
    }),
  );
});

describe("native goal proof", () => {
  const goal = (status: string): Schema.JsonObject => ({
    threadId: "source",
    objective: "preserve goal",
    status,
    tokenBudget: 100,
    tokensUsed: 10,
    timeUsedSeconds: 2,
    createdAt: 1,
    updatedAt: 2,
    unknown: { futureGoalState: true },
  });

  for (const status of ["paused", "blocked", "usageLimited", "budgetLimited", "complete"])
    it.effect(`retains an idle ${status} goal through native deferred copying`, () =>
      Effect.gen(function* () {
        const fixture = makeClient();
        fixture.threads.get("source")!.nativeGoal = goal(status);
        const source = yield* readSource(fixture.client);
        const fork = yield* forkCodexConversation(fixture.client, { source });
        NodeAssert.deepEqual(fork.nativeGoal, source.nativeGoal);
        NodeAssert.equal(codexConversationDigest(fork), codexConversationDigest(source));
        NodeAssert.equal(
          typeof fork.nativeGoal === "object" &&
            fork.nativeGoal !== null &&
            "threadId" in fork.nativeGoal,
          false,
        );
      }),
    );

  for (const nativeGoal of [
    goal("active"),
    goal("futureActive"),
    { ...goal("paused"), threadId: "foreign" },
    { threadId: "source", status: "paused" },
    { ...goal("paused"), tokensUsed: "unknown" },
  ])
    it.effect(`rejects unproven native goal ${JSON.stringify(nativeGoal)}`, () =>
      Effect.gen(function* () {
        const fixture = makeClient();
        fixture.threads.get("source")!.nativeGoal = nativeGoal;
        NodeAssert.equal(
          (yield* Effect.flip(readSource(fixture.client)))._tag,
          "CodexAppServerRequestError",
        );
      }),
    );

  it.effect(
    "does not establish exact eligibility when native goal introspection is unsupported",
    () =>
      Effect.gen(function* () {
        const fixture = makeClient();
        const unsupported: Parameters<typeof readCodexConversation>[0] = {
          ...fixture.client,
          raw: {
            request: (method, params) =>
              method === "thread/goal/get"
                ? Effect.fail(CodexErrors.CodexAppServerRequestError.internalError("unsupported"))
                : fixture.client.raw.request(method, params),
          },
        };
        NodeAssert.equal(
          (yield* Effect.flip(readSource(unsupported)))._tag,
          "CodexAppServerRequestError",
        );
      }),
  );

  it.effect("detects changed native goal state with identical public turns and JSONL", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      fixture.threads.get("source")!.nativeGoal = goal("paused");
      const source = yield* readSource(fixture.client);
      fixture.hooks.response = (method, _params, response) => {
        if (method === "thread/fork")
          fixture.threads.get("fork-1")!.nativeGoal = {
            ...goal("paused"),
            threadId: "fork-1",
            tokensUsed: 11,
          };
        return response;
      };
      NodeAssert.match(
        (yield* Effect.flip(forkCodexConversation(fixture.client, { source }))).message,
        /changed retained turn content or identities/,
      );
    }),
  );

  it.effect("detects a native goal appearing while history is read", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      let reads = 0;
      fixture.hooks.response = (method, _params, response) =>
        method === "thread/goal/get" && ++reads === 2 ? { goal: goal("paused") } : response;
      NodeAssert.match(
        (yield* Effect.flip(readSource(fixture.client))).message,
        /native goal changed while reading/,
      );
    }),
  );

  it.effect("rejects dropped or changed unknown goal state even when history matches", () =>
    Effect.gen(function* () {
      for (const changed of [
        null,
        { ...goal("paused"), threadId: "fork-1", unknown: { futureGoalState: false } },
      ]) {
        const fixture = makeClient();
        fixture.threads.get("source")!.nativeGoal = goal("paused");
        const source = yield* readSource(fixture.client);
        fixture.hooks.response = (method, _params, response) => {
          if (method === "thread/fork") fixture.threads.get("fork-1")!.nativeGoal = changed;
          return response;
        };
        NodeAssert.match(
          (yield* Effect.flip(forkCodexConversation(fixture.client, { source }))).message,
          /changed retained turn content or identities/,
        );
      }
    }),
  );

  it.effect("rejects source goal edits during native fork verification", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      fixture.threads.get("source")!.nativeGoal = goal("paused");
      const source = yield* readSource(fixture.client);
      fixture.hooks.response = (method, _params, response) => {
        if (method === "thread/fork")
          fixture.threads.get("source")!.nativeGoal = { ...goal("paused"), tokensUsed: 12 };
        return response;
      };
      NodeAssert.match(
        (yield* Effect.flip(forkCodexConversation(fixture.client, { source }))).message,
        /source changed during fork verification/,
      );
    }),
  );

  it.effect("does not infer prior goal state from an earlier public turn", () =>
    Effect.gen(function* () {
      const fixture = makeClient();
      fixture.threads.get("source")!.nativeGoal = goal("paused");
      const source = yield* readSource(fixture.client);
      NodeAssert.match(
        (yield* Effect.flip(
          forkCodexConversation(fixture.client, { source, lastTurnId: "turn-1" }),
        )).message,
        /historical goal state/,
      );
      NodeAssert.equal(
        fixture.calls.some((call) => call.method === "thread/fork"),
        false,
      );
    }),
  );
});
