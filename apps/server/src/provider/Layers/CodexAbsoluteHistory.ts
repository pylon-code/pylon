// @effect-diagnostics nodeBuiltinImport:off
// Node builtins here are pure digest/path operations; runtime-owned Effect services perform I/O.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

export interface CodexConversationSnapshot {
  readonly threadId: string;
  readonly cwd: string;
  readonly turns: ReadonlyArray<Schema.Json>;
  readonly rolloutPath: string;
  readonly nativeRecords: ReadonlyArray<Schema.Json>;
  readonly nativeGoal: Schema.Json;
}

type CodexHistoryClient = {
  readonly raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">;
  readonly readRollout?: (path: string) => Effect.Effect<string, CodexErrors.CodexAppServerError>;
  readonly forkOptions?: Readonly<Record<string, Schema.Json>>;
};

export const CODEX_ROLLOUT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROLLOUT_RECORDS = 100_000;
const MAX_ROLLOUT_LINE_BYTES = 1024 * 1024;
const RESERVED_FORK_OPTIONS = new Set([
  "threadId",
  "cwd",
  "ephemeral",
  "deferGoalContinuation",
  "path",
  "lastTurnId",
  "beforeTurnId",
]);

const ConversationMetadata = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.NonEmptyString,
    cwd: Schema.NonEmptyString,
    ephemeral: Schema.Boolean,
    status: Schema.Struct({ type: Schema.String }),
    historyMode: Schema.optionalKey(Schema.Literals(["legacy", "paginated"])),
    forkedFromId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    path: Schema.optionalKey(Schema.NullOr(Schema.String)),
    // Json keeps every native field, including fields newer than the pinned protocol.
    turns: Schema.optionalKey(Schema.Array(Schema.Json)),
  }),
  cwd: Schema.optionalKey(Schema.String),
});
const ConversationTurn = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.Literals(["completed", "interrupted", "failed", "inProgress"]),
  itemsView: Schema.optionalKey(Schema.Literals(["full", "summary", "notLoaded"])),
  items: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, type: Schema.NonEmptyString })),
});
const ConversationTurnsPage = Schema.Struct({
  data: Schema.Array(Schema.Json),
  nextCursor: Schema.NullOr(Schema.String),
});

const decodeMetadata = Schema.decodeUnknownEffect(ConversationMetadata);
const decodeTurn = Schema.decodeUnknownEffect(ConversationTurn);
const decodeTurnsPage = Schema.decodeUnknownEffect(ConversationTurnsPage);
const decodeNativeRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
const decodeNativeEnvelope = Schema.decodeUnknownEffect(
  Schema.Struct({
    timestamp: Schema.NonEmptyString,
    ordinal: Schema.optionalKey(Schema.Number),
    type: Schema.NonEmptyString,
    payload: Schema.Record(Schema.String, Schema.Json),
  }),
);
const decodeNativeSession = Schema.decodeUnknownEffect(
  Schema.Struct({
    id: Schema.NonEmptyString,
    cwd: Schema.NonEmptyString,
    timestamp: Schema.NonEmptyString,
    session_id: Schema.optionalKey(Schema.NonEmptyString),
    forked_from_id: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
    context_window: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ window_id: Schema.NonEmptyString })),
    ),
  }),
);
const decodeNativeGoal = Schema.decodeUnknownEffect(
  Schema.Struct({
    goal: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
  }),
);
const decodeIdleNativeGoal = Schema.decodeUnknownEffect(
  Schema.Struct({
    threadId: Schema.NonEmptyString,
    status: Schema.Literals(["paused", "blocked", "usageLimited", "budgetLimited", "complete"]),
    objective: Schema.NonEmptyString,
    tokenBudget: Schema.NullOr(Schema.Int),
    tokensUsed: Schema.Int,
    timeUsedSeconds: Schema.Int,
    createdAt: Schema.Int,
    updatedAt: Schema.Int,
  }),
);
const isNativeTurnStart = Schema.is(
  Schema.Struct({
    type: Schema.Literal("event_msg"),
    payload: Schema.Struct({
      type: Schema.Literals(["task_started", "turn_started"]),
      turn_id: Schema.NonEmptyString,
    }),
  }),
);
const isNativeContextWindow = Schema.is(Schema.Record(Schema.String, Schema.Json));

const invalidHistory = (method: string, message: string) =>
  CodexErrors.CodexAppServerRequestError.internalError(message, undefined, {
    method,
    operation: "decode-payload",
  });

const validateMetadata = Effect.fn("CodexAbsoluteHistory.validateMetadata")(function* (
  response: unknown,
  method: string,
  threadId: string | undefined,
  cwd: string,
  requireLoaded = false,
) {
  const metadata = yield* decodeMetadata(response).pipe(
    Effect.mapError((cause) =>
      CodexErrors.CodexAppServerRequestError.invalidPayload(method, "decode-payload", cause),
    ),
  );
  if (
    (threadId !== undefined && metadata.thread.id !== threadId) ||
    metadata.thread.cwd !== cwd ||
    (metadata.cwd !== undefined && metadata.cwd !== cwd)
  ) {
    return yield* invalidHistory(
      method,
      "Codex conversation identity or working directory changed.",
    );
  }
  if (
    metadata.thread.ephemeral ||
    (metadata.thread.status.type !== "idle" &&
      (requireLoaded || metadata.thread.status.type !== "notLoaded"))
  ) {
    return yield* invalidHistory(method, "Codex conversation must be persistent and idle.");
  }
  return metadata.thread;
});

const validateTurns = Effect.fn("CodexAbsoluteHistory.validateTurns")(function* (
  turns: ReadonlyArray<Schema.Json>,
  method: string,
) {
  const ids = new Set<string>();
  const decoded = [];
  for (const turn of turns) {
    const metadata = yield* decodeTurn(turn).pipe(
      Effect.mapError((cause) =>
        CodexErrors.CodexAppServerRequestError.invalidPayload(method, "decode-payload", cause),
      ),
    );
    if (
      metadata.status === "inProgress" ||
      (metadata.itemsView !== undefined && metadata.itemsView !== "full") ||
      ids.has(metadata.id)
    ) {
      return yield* invalidHistory(
        method,
        "Codex conversation history is incomplete or ambiguous.",
      );
    }
    if (new Set(metadata.items.map((item) => item.id)).size !== metadata.items.length) {
      return yield* invalidHistory(
        method,
        "Codex conversation contains duplicate item identities.",
      );
    }
    ids.add(metadata.id);
    decoded.push(metadata);
  }
  return decoded;
});

function canonicalJson(value: Schema.Json): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

const readNativeRecords = Effect.fn("CodexAbsoluteHistory.readNativeRecords")(function* (
  client: CodexHistoryClient,
  path: string | null | undefined,
  threadId: string,
  cwd: string,
  expectedParent?: string,
) {
  if (!client.readRollout || !path || !NodePath.isAbsolute(path) || path.includes("\0"))
    return yield* invalidHistory("thread/read", "Codex native history proof is unavailable.");
  const text = yield* client.readRollout(path);
  if (Buffer.byteLength(text, "utf8") > CODEX_ROLLOUT_MAX_BYTES || !text.endsWith("\n"))
    return yield* invalidHistory("thread/read", "Codex native history is oversized or incomplete.");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > MAX_ROLLOUT_RECORDS)
    return yield* invalidHistory("thread/read", "Codex native history exceeds the record bound.");
  const records: Array<Schema.Json> = [];
  let leadingSessionHeaders = true;
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || Buffer.byteLength(line, "utf8") > MAX_ROLLOUT_LINE_BYTES)
      return yield* invalidHistory(
        "thread/read",
        "Codex native history contains an invalid record.",
      );
    const record = yield* decodeNativeRecord(line).pipe(
      Effect.mapError(() =>
        invalidHistory("thread/read", "Codex native history is not valid JSONL."),
      ),
    );
    const envelope = yield* decodeNativeEnvelope(record).pipe(
      Effect.mapError(() =>
        invalidHistory("thread/read", "Codex native history has an invalid envelope."),
      ),
    );
    if (index === 0 && envelope.type !== "session_meta")
      return yield* invalidHistory(
        "thread/read",
        "Codex native history omitted its session identity.",
      );
    if (
      envelope.ordinal !== undefined &&
      (!Number.isSafeInteger(envelope.ordinal) || envelope.ordinal < 0)
    )
      return yield* invalidHistory("thread/read", "Codex native history has an invalid ordinal.");
    let payload = envelope.payload;
    if (envelope.type === "session_meta") {
      const session = yield* decodeNativeSession(payload).pipe(
        Effect.mapError(() =>
          invalidHistory("thread/read", "Codex native history has an invalid session identity."),
        ),
      );
      if (index === 0 && (session.id !== threadId || session.cwd !== cwd))
        return yield* invalidHistory(
          "thread/read",
          "Codex native history belongs to another conversation.",
        );
      if (index === 0 && expectedParent !== undefined && session.forked_from_id !== expectedParent)
        return yield* invalidHistory(
          "thread/read",
          "Codex native history has unverified fork provenance.",
        );
      if (payload.history_base != null)
        return yield* invalidHistory(
          "thread/read",
          "Codex native history depends on an unverified external base.",
        );
      payload = Object.fromEntries(
        Object.entries(payload).filter(
          ([key]) => !["id", "session_id", "forked_from_id", "timestamp"].includes(key),
        ),
      );
      if (isNativeContextWindow(payload.context_window)) {
        const { context_window: _contextWindow, ...rest } = payload;
        const contextWindow = Object.fromEntries(
          Object.entries(payload.context_window).filter(([key]) => key !== "window_id"),
        );
        payload = {
          ...rest,
          ...(Object.keys(contextWindow).length === 0 ? {} : { context_window: contextWindow }),
        };
      }
      if (isNativeContextWindow(payload.git)) {
        const { git: _git, ...rest } = payload;
        // recorder::write_session_meta recollects these informational fields from the current
        // checkout. Unknown Git fields remain part of the proof.
        const git = Object.fromEntries(
          Object.entries(payload.git).filter(
            ([key]) => !["commit_hash", "branch", "repository_url"].includes(key),
          ),
        );
        payload = { ...rest, ...(Object.keys(git).length === 0 ? {} : { git }) };
      }
    }
    // The pinned native recorder rewrites only these enclosing fields when replaying a fork.
    // Payload timestamps, context, tool relationships, and every unknown field remain semantic.
    const normalized = {
      ...Object.fromEntries(
        Object.entries(record).filter(
          ([key]) => !["timestamp", "ordinal", "payload"].includes(key),
        ),
      ),
      payload,
    };
    // A native fork prepends its own session header to the copied history. Only an identical
    // normalized adjacent header can be elided; differences in context must fail verification.
    if (
      leadingSessionHeaders &&
      envelope.type === "session_meta" &&
      records.length > 0 &&
      canonicalJson(records.at(-1)!) === canonicalJson(normalized)
    )
      continue;
    if (envelope.type !== "session_meta") leadingSessionHeaders = false;
    records.push(normalized);
  }
  return { path, records, text };
});

/** Public identities and full native inference context are semantic; native file identity is not. */
export function codexConversationDigest(snapshot: CodexConversationSnapshot): string {
  return NodeCrypto.createHash("sha256")
    .update(
      canonicalJson({
        cwd: snapshot.cwd,
        turns: snapshot.turns,
        nativeRecords: snapshot.nativeRecords,
        nativeGoal: snapshot.nativeGoal,
      }),
    )
    .digest("hex");
}

const readNativeGoal = Effect.fn("CodexAbsoluteHistory.readNativeGoal")(function* (
  client: CodexHistoryClient,
  threadId: string,
) {
  const { goal } = yield* decodeNativeGoal(
    yield* client.raw.request("thread/goal/get", { threadId }),
  ).pipe(
    Effect.mapError(() =>
      invalidHistory("thread/goal/get", "Codex native goal proof is unavailable."),
    ),
  );
  if (goal === null) return null;
  const metadata = yield* decodeIdleNativeGoal(goal).pipe(
    Effect.mapError(() =>
      invalidHistory("thread/goal/get", "Codex native goal is not provably idle."),
    ),
  );
  if (metadata.threadId !== threadId)
    return yield* invalidHistory(
      "thread/goal/get",
      "Codex native goal belongs to another conversation.",
    );
  return Object.fromEntries(Object.entries(goal).filter(([key]) => key !== "threadId"));
});

export const readCodexConversation = Effect.fn("readCodexConversation")(function* (
  client: CodexHistoryClient,
  threadId: string,
  cwd: string,
  options?: { readonly requireLoaded?: boolean },
): Effect.fn.Return<CodexConversationSnapshot, CodexErrors.CodexAppServerError> {
  const metadata = yield* validateMetadata(
    yield* client.raw.request("thread/read", { threadId, includeTurns: false }),
    "thread/read",
    threadId,
    cwd,
    options?.requireLoaded,
  );
  const nativeGoal = yield* readNativeGoal(client, threadId);
  const native = yield* readNativeRecords(
    client,
    metadata.path,
    threadId,
    cwd,
    metadata.forkedFromId ?? undefined,
  );
  const turns: Array<Schema.Json> = [];
  if (metadata.historyMode !== "paginated") {
    const history = yield* validateMetadata(
      yield* client.raw.request("thread/read", { threadId, includeTurns: true }),
      "thread/read",
      threadId,
      cwd,
      options?.requireLoaded,
    );
    if (
      history.historyMode === "paginated" ||
      history.turns === undefined ||
      history.path !== native.path
    ) {
      return yield* invalidHistory(
        "thread/read",
        "Codex conversation did not return full history.",
      );
    }
    turns.push(...history.turns);
  } else {
    const requestedCursors = new Set<string | null>();
    let cursor: string | null = null;
    do {
      if (requestedCursors.has(cursor)) {
        return yield* invalidHistory(
          "thread/turns/list",
          "Codex history pagination repeated a cursor.",
        );
      }
      requestedCursors.add(cursor);
      const page: typeof ConversationTurnsPage.Type = yield* decodeTurnsPage(
        yield* client.raw.request("thread/turns/list", {
          threadId,
          cursor,
          limit: 100,
          sortDirection: "asc",
          itemsView: "full",
        }),
      ).pipe(
        Effect.mapError((cause) =>
          CodexErrors.CodexAppServerRequestError.invalidPayload(
            "thread/turns/list",
            "decode-payload",
            cause,
          ),
        ),
      );
      turns.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
  yield* validateTurns(turns, "thread/read");
  const after = yield* validateMetadata(
    yield* client.raw.request("thread/read", { threadId, includeTurns: false }),
    "thread/read",
    threadId,
    cwd,
    options?.requireLoaded,
  );
  if (after.historyMode !== metadata.historyMode || after.path !== native.path)
    return yield* invalidHistory(
      "thread/read",
      "Codex conversation history scope changed while reading.",
    );
  const verifiedGoal = yield* readNativeGoal(client, threadId);
  if (canonicalJson(verifiedGoal) !== canonicalJson(nativeGoal))
    return yield* invalidHistory("thread/goal/get", "Codex native goal changed while reading.");
  const verifiedNative = yield* readNativeRecords(
    client,
    after.path,
    threadId,
    cwd,
    after.forkedFromId ?? undefined,
  );
  if (verifiedNative.text !== native.text)
    return yield* invalidHistory("thread/read", "Codex native history changed while reading.");
  return {
    threadId,
    cwd,
    turns,
    rolloutPath: native.path,
    nativeRecords: native.records,
    nativeGoal,
  };
});

export const forkCodexConversation = Effect.fn("forkCodexConversation")(function* (
  client: CodexHistoryClient,
  input: { readonly source: CodexConversationSnapshot; readonly lastTurnId?: string },
): Effect.fn.Return<CodexConversationSnapshot, CodexErrors.CodexAppServerError> {
  const { source, lastTurnId } = input;
  const sourceTurns = yield* validateTurns(source.turns, "thread/fork");
  const boundaryIndex =
    lastTurnId === undefined
      ? sourceTurns.length - 1
      : sourceTurns.findIndex((turn) => turn.id === lastTurnId);
  if (
    lastTurnId !== undefined &&
    (boundaryIndex < 0 || sourceTurns[boundaryIndex]?.status !== "completed")
  ) {
    return yield* invalidHistory(
      "thread/fork",
      "Codex fork target must identify an exact completed turn.",
    );
  }
  if (source.nativeGoal !== null && boundaryIndex !== sourceTurns.length - 1)
    return yield* invalidHistory(
      "thread/fork",
      "Codex historical goal state has no verified native boundary.",
    );
  let nativeBoundary = source.nativeRecords.length;
  if (lastTurnId !== undefined) {
    // Pinned truncate_rollout_after_turn_id keeps every record through the next explicit
    // TurnStarted boundary. Public item counts cannot identify this native context boundary.
    const starts = source.nativeRecords.flatMap((record, index) =>
      isNativeTurnStart(record) ? [{ index, turnId: record.payload.turn_id }] : [],
    );
    const nativeStart = starts.findIndex(({ turnId }) => turnId === lastTurnId);
    if (nativeStart < 0 || starts.filter(({ turnId }) => turnId === lastTurnId).length !== 1)
      return yield* invalidHistory(
        "thread/fork",
        "Codex fork target has no unambiguous native boundary.",
      );
    nativeBoundary = starts[nativeStart + 1]?.index ?? source.nativeRecords.length;
  }
  const expected = {
    ...source,
    turns: source.turns.slice(0, boundaryIndex + 1),
    nativeRecords: source.nativeRecords.slice(0, nativeBoundary),
  };
  const expectedDigest = codexConversationDigest(expected);
  const sourceDigest = codexConversationDigest(source);
  const before = yield* readCodexConversation(client, source.threadId, source.cwd);
  if (
    before.rolloutPath !== source.rolloutPath ||
    codexConversationDigest(before) !== sourceDigest
  ) {
    return yield* invalidHistory("thread/fork", "Codex fork source changed after capture.");
  }
  const forked = yield* validateMetadata(
    yield* client.raw.request("thread/fork", {
      ...Object.fromEntries(
        Object.entries(client.forkOptions ?? {}).filter(([key]) => !RESERVED_FORK_OPTIONS.has(key)),
      ),
      threadId: source.threadId,
      ...(lastTurnId !== undefined ? { lastTurnId } : {}),
      cwd: source.cwd,
      ephemeral: false,
      deferGoalContinuation: true,
    }),
    "thread/fork",
    undefined,
    source.cwd,
    true,
  );
  if (
    forked.id === source.threadId ||
    forked.path === source.rolloutPath ||
    (forked.forkedFromId != null && forked.forkedFromId !== source.threadId)
  ) {
    return yield* invalidHistory(
      "thread/fork",
      "Codex fork did not return a distinct private conversation.",
    );
  }
  yield* readNativeRecords(client, forked.path, forked.id, source.cwd, source.threadId);
  // Paginated forks may omit their turns from this response; the complete reread is authoritative.
  if (forked.historyMode !== "paginated") {
    if (forked.turns === undefined) {
      return yield* invalidHistory("thread/fork", "Codex fork response omitted retained history.");
    }
    yield* validateTurns(forked.turns, "thread/fork");
    if (
      codexConversationDigest({ ...expected, threadId: forked.id, turns: forked.turns }) !==
      expectedDigest
    ) {
      return yield* invalidHistory("thread/fork", "Codex fork response changed retained history.");
    }
  }
  const snapshot = yield* readCodexConversation(client, forked.id, source.cwd, {
    requireLoaded: true,
  });
  const retainedTurns = yield* validateTurns(snapshot.turns, "thread/fork");
  if (
    retainedTurns.length !== boundaryIndex + 1 ||
    snapshot.rolloutPath !== forked.path ||
    retainedTurns.some((turn, index) => turn.id !== sourceTurns[index]?.id) ||
    codexConversationDigest(snapshot) !== expectedDigest
  ) {
    return yield* invalidHistory(
      "thread/fork",
      "Codex fork changed retained turn content or identities.",
    );
  }
  const after = yield* readCodexConversation(client, source.threadId, source.cwd);
  if (after.rolloutPath !== source.rolloutPath || codexConversationDigest(after) !== sourceDigest) {
    return yield* invalidHistory(
      "thread/fork",
      "Codex fork source changed during fork verification.",
    );
  }
  return snapshot;
});
