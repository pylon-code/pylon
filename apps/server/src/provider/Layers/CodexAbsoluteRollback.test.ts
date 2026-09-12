// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import {
  CheckpointRef,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import { makeCodexAbsoluteRollback, readCodexExactCursor } from "./CodexAbsoluteRollback.ts";
import type { CodexConversationSnapshot } from "./CodexAbsoluteHistory.ts";
import type { CodexSessionRuntimeShape } from "./CodexSessionRuntime.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { ProviderDriverKind } from "@t3tools/contracts";

const decodeSnapshotTurns = Schema.decodeUnknownEffect(
  Schema.Struct({ snapshot: Schema.Struct({ turns: Schema.Array(Schema.Json) }) }),
);
const threadId = ThreadId.make("pylon-thread");
const instanceId = ProviderInstanceId.make("codex-test");
const incarnationId = RuntimeSessionId.make("incarnation-1");
const cwd = "/tmp/codex-absolute-test";
const turn = (id: string, text = id): Schema.Json => ({
  id,
  status: "completed",
  itemsView: "full",
  items: [{ id: `${id}-item`, type: "userMessage", content: [{ type: "text", text }] }],
});
const checkpoint = (id: string | null, count: number) => ({
  kind: "checkpoint" as const,
  checkpointTurnCount: count,
  turnId: id === null ? null : TurnId.make(id),
  checkpointRef: CheckpointRef.make(`checkpoint-${count}`),
  checkpointOid: `oid-${count}`,
  sourceRevision: count,
});
const source = (id: string | null, count: number) => ({
  ...checkpoint(id, count),
  kind: "source" as const,
});

function harness(initial: ReadonlyArray<Schema.Json> = []) {
  let selected = "live";
  let counter = 0;
  let idle = true;
  let current = true;
  let quarantined = false;
  const histories = new Map<string, CodexConversationSnapshot>([
    [
      selected,
      {
        threadId: selected,
        cwd,
        turns: initial,
        nativeGoal: null,
        nativeRecords: [{ type: "test-native-proof" }, ...initial],
        rolloutPath: "/tmp/codex-absolute-test/native.jsonl",
      },
    ],
  ]);
  const quarantineStates: boolean[] = [];
  const read = (id = selected) =>
    Effect.suspend(() => {
      const value = histories.get(id);
      return value
        ? Effect.succeed(structuredClone(value))
        : Effect.fail(CodexErrors.CodexAppServerRequestError.internalError("missing snapshot"));
    });
  const native: NonNullable<CodexSessionRuntimeShape["absoluteConversation"]> = {
    isIdle: Effect.sync(() => idle),
    read,
    fork: ({ source: snapshot }) =>
      Effect.sync(() => {
        const forked = { ...structuredClone(snapshot), threadId: `fork-${++counter}` };
        histories.set(forked.threadId, forked);
        return forked;
      }),
    select: (snapshot) =>
      Effect.sync(() => {
        selected = snapshot.threadId;
      }),
    quarantine: (held) =>
      Effect.sync(() => {
        quarantined = held;
        quarantineStates.push(held);
      }),
  };
  const make = (
    options: {
      incarnation?: RuntimeSessionId;
      recovering?: boolean;
      targetThreadId?: ThreadId;
      targetCwd?: string;
    } = {},
  ) =>
    makeCodexAbsoluteRollback({
      threadId: options.targetThreadId ?? threadId,
      instanceId,
      incarnationId: options.incarnation ?? incarnationId,
      cwd: options.targetCwd ?? cwd,
      runtime: { absoluteConversation: native },
      recovering: options.recovering ?? false,
      requireCurrent: Effect.suspend(() =>
        current
          ? Effect.void
          : Effect.fail(
              new ProviderAdapterValidationError({
                provider: ProviderDriverKind.make("codex"),
                operation: "test",
                issue: "retired owner",
              }),
            ),
      ),
    });
  const controller = make();
  return {
    controller,
    make,
    histories,
    quarantineStates,
    native,
    setTurns: (turns: ReadonlyArray<Schema.Json>) =>
      histories.set(selected, {
        threadId: selected,
        cwd,
        turns,
        nativeGoal: null,
        nativeRecords: [{ type: "test-native-proof" }, ...turns],
        rolloutPath: "/tmp/codex-absolute-test/native.jsonl",
      }),
    setIdle: (value: boolean) => {
      idle = value;
    },
    retire: () => {
      current = false;
    },
    get selected() {
      return selected;
    },
    get quarantined() {
      return quarantined;
    },
    get forks() {
      return counter;
    },
  };
}
const capture = (
  controller: ReturnType<typeof makeCodexAbsoluteRollback>,
  binding: ReturnType<typeof checkpoint> | ReturnType<typeof source>,
) => controller.operations.captureAnchor({ threadId, binding });
const twoTurns = Effect.fn("test.twoTurns")(function* () {
  const h = harness();
  yield* h.controller.initialize();
  const root = yield* capture(h.controller, checkpoint(null, 0));
  h.setTurns([turn("one")]);
  yield* h.controller.recordCompleted("one");
  const first = yield* capture(h.controller, checkpoint("one", 1));
  h.setTurns([turn("one"), turn("two")]);
  yield* h.controller.recordCompleted("two");
  const original = yield* capture(h.controller, source("two", 2));
  return { h, root, first, original };
});

describe("Codex exact rollback ownership", () => {
  it.effect(
    "selects an immutable absolute target, retries idempotently, and compensates to the intact source",
    () =>
      Effect.gen(function* () {
        const { h, first, original } = yield* twoTurns();
        const originalLive = h.selected;
        const originalContents = structuredClone(h.histories.get(originalLive));
        NodeAssert.equal(h.quarantined, true);
        yield* h.controller.operations.applyAnchor(threadId, first.anchor);
        NodeAssert.notEqual(h.selected, originalLive);
        NodeAssert.equal(
          (yield* h.controller.operations.inspectAnchor(threadId)).digest,
          first.digest,
        );
        const count = h.forks;
        yield* h.controller.operations.applyAnchor(threadId, first.anchor);
        NodeAssert.equal(h.forks, count);
        NodeAssert.deepEqual(h.histories.get(originalLive), originalContents);
        yield* h.controller.operations.applyAnchor(threadId, original.anchor);
        NodeAssert.equal(
          (yield* h.controller.operations.inspectAnchor(threadId)).digest,
          original.digest,
        );
        yield* h.controller.operations.releaseAnchor(threadId, original.anchor);
        NodeAssert.equal(h.quarantined, false);
        NodeAssert.ok(readCodexExactCursor(h.controller.cursor()));
      }),
  );
  it.effect("supports root only from the proven empty startup snapshot", () =>
    Effect.gen(function* () {
      const { h, root } = yield* twoTurns();
      yield* h.controller.operations.applyAnchor(threadId, root.anchor);
      NodeAssert.deepEqual(h.histories.get(h.selected)?.turns, []);
      const old = harness([turn("old")]);
      yield* old.controller.initialize();
      NodeAssert.equal(yield* old.controller.operations.isAvailable(threadId), false);
      NodeAssert.ok(
        Exit.isFailure(yield* Effect.exit(capture(old.controller, checkpoint(null, 0)))),
      );
    }),
  );
  it.effect(
    "refuses an unrecorded completion even when native history is idle and has that turn ID",
    () =>
      Effect.gen(function* () {
        const h = harness([turn("one")]);
        NodeAssert.ok(Exit.isFailure(yield* Effect.exit(capture(h.controller, source("one", 1)))));
        NodeAssert.equal(h.quarantined, true);
      }),
  );
  it.effect("rejects external edits retaining the recorded tail ID", () =>
    Effect.gen(function* () {
      const h = harness([turn("one")]);
      yield* h.controller.recordCompleted("one");
      h.setTurns([turn("one", "external replacement")]);
      NodeAssert.ok(Exit.isFailure(yield* Effect.exit(capture(h.controller, source("one", 1)))));
      NodeAssert.equal(h.controller.cursor(), undefined);
    }),
  );
  it.effect("duplicate completion cannot replace the first immutable Pylon turn binding", () =>
    Effect.gen(function* () {
      const h = harness([turn("one")]);
      yield* h.controller.recordCompleted("one");
      const original = yield* capture(h.controller, checkpoint("one", 1));
      const forks = h.forks;
      yield* h.controller.recordCompleted("one");
      NodeAssert.equal(h.forks, forks);
      h.setTurns([turn("one", "external replacement")]);
      NodeAssert.ok(Exit.isFailure(yield* Effect.exit(h.controller.recordCompleted("one"))));
      NodeAssert.equal(
        (yield* capture(h.controller, checkpoint("one", 1))).digest,
        original.digest,
      );
      NodeAssert.ok(Exit.isFailure(yield* Effect.exit(capture(h.controller, source("one", 1)))));
    }),
  );
  it.effect("refuses count guesses and keeps a checkpoint tied to its original full contents", () =>
    Effect.gen(function* () {
      const h = harness([turn("one")]);
      yield* h.controller.recordCompleted("one");
      NodeAssert.ok(
        Exit.isFailure(yield* Effect.exit(capture(h.controller, checkpoint("unknown", 1)))),
      );
      NodeAssert.ok(
        Exit.isFailure(
          yield* Effect.exit(capture(h.controller, { ...checkpoint("one", 1), sourceRevision: 2 })),
        ),
      );
      h.setTurns([turn("one", "external edit")]);
      const anchored = yield* capture(h.controller, checkpoint("one", 1));
      const decoded = yield* decodeSnapshotTurns(anchored.anchor);
      NodeAssert.deepEqual(decoded.snapshot.turns, [turn("one")]);
    }),
  );
  it.effect("requires recovery preparation and release before input or output resumes", () =>
    Effect.gen(function* () {
      const { h, first, original } = yield* twoTurns();
      const cursor = h.controller.cursor();
      NodeAssert.ok(cursor);
      const recovered = h.make({ recovering: true });
      yield* recovered.recover(cursor);
      NodeAssert.equal(recovered.outputAllowed(), false);
      NodeAssert.ok(Exit.isFailure(yield* Effect.exit(recovered.beforeMutation)));
      yield* recovered.operations.prepareRecovery!({
        threadId,
        sourceAnchor: original.anchor,
        desiredAnchor: first.anchor,
        expectedAnchor: original.anchor,
      });
      yield* recovered.activate;
      NodeAssert.equal(recovered.outputAllowed(), false);
      yield* recovered.operations.applyAnchor(threadId, first.anchor);
      yield* recovered.operations.releaseAnchor(threadId, first.anchor);
      NodeAssert.equal(recovered.outputAllowed(), true);
      yield* recovered.beforeMutation;
      NodeAssert.equal(recovered.cursor(), undefined);
    }),
  );
  it.effect(
    "rejects same-incarnation recovery for a different incarnation, Pylon thread, cwd, or changed snapshot",
    () =>
      Effect.gen(function* () {
        const { h } = yield* twoTurns();
        const cursor = h.controller.cursor();
        NodeAssert.ok(cursor);
        for (const options of [
          { incarnation: RuntimeSessionId.make("other") },
          { targetThreadId: ThreadId.make("other") },
          { targetCwd: "/elsewhere" },
        ]) {
          NodeAssert.ok(
            Exit.isFailure(
              yield* Effect.exit(h.make({ ...options, recovering: true }).recover(cursor)),
            ),
          );
        }
        h.setTurns([turn("one"), turn("two", "changed")]);
        NodeAssert.ok(
          Exit.isFailure(yield* Effect.exit(h.make({ recovering: true }).recover(cursor))),
        );
      }),
  );
  it.effect(
    "ordinary Stop/resume rebinds verified history to a new incarnation without losing history",
    () =>
      Effect.gen(function* () {
        const { h, original } = yield* twoTurns();
        yield* h.controller.operations.releaseAnchor(threadId, original.anchor);
        const previous = h.controller.cursor();
        NodeAssert.ok(previous);
        const contents = structuredClone(h.histories.get(h.selected));
        const resumed = h.make({ incarnation: RuntimeSessionId.make("next-incarnation") });
        yield* resumed.initialize(previous);
        NodeAssert.deepEqual(h.histories.get(h.selected), contents);
        NodeAssert.equal(
          resumed.cursor()?.exactRollback.anchor.sessionIncarnationId,
          "next-incarnation",
        );
        NodeAssert.equal((yield* capture(resumed, source("two", 2))).digest, original.digest);
      }),
  );
  it.effect(
    "ordinary resume preserves changed native history but drops old exact eligibility",
    () =>
      Effect.gen(function* () {
        const { h, original } = yield* twoTurns();
        yield* h.controller.operations.releaseAnchor(threadId, original.anchor);
        const previous = h.controller.cursor();
        NodeAssert.ok(previous);
        h.setTurns([turn("new-external-turn")]);
        const selected = h.selected;
        const resumed = h.make({ incarnation: RuntimeSessionId.make("next-incarnation") });
        yield* resumed.initialize(previous);
        NodeAssert.equal(h.selected, selected);
        NodeAssert.deepEqual(h.histories.get(selected)?.turns, [turn("new-external-turn")]);
        NodeAssert.equal(resumed.cursor(), undefined);
        NodeAssert.equal(yield* resumed.operations.isAvailable(threadId), false);
      }),
  );
  it.effect(
    "owned compaction refreshes source proof while retaining the original checkpoint through recovery",
    () =>
      Effect.gen(function* () {
        const h = harness([turn("one")]);
        yield* h.controller.recordCompleted("one");
        const original = yield* capture(h.controller, checkpoint("one", 1));
        yield* h.controller.beforeCompaction;
        NodeAssert.equal(h.controller.cursor(), undefined);
        const compactedTurns = [
          turn("one"),
          {
            id: "compact-1",
            status: "completed",
            itemsView: "full",
            items: [{ id: "compaction-item", type: "contextCompaction" }],
          },
        ];
        h.setTurns(compactedTurns);
        yield* h.controller.finishCompaction();
        NodeAssert.equal(
          h.controller.cursor(),
          undefined,
          "acknowledgement alone cannot establish a proof",
        );
        h.controller.compactionReceipt("compact-1");
        yield* h.controller.finishCompaction();
        const cursor = readCodexExactCursor(h.controller.cursor());
        NodeAssert.ok(cursor);
        NodeAssert.deepEqual(cursor.exactRollback.anchor.compactionCheckpoint?.turns, [
          turn("one"),
        ]);
        const current = yield* capture(h.controller, source("one", 1));
        NodeAssert.notEqual(current.digest, original.digest);
        NodeAssert.equal(
          (yield* capture(h.controller, checkpoint("one", 1))).digest,
          original.digest,
        );
        const recovered = h.make({ recovering: true });
        yield* recovered.recover(cursor);
        yield* recovered.operations.prepareRecovery!({
          threadId,
          sourceAnchor: current.anchor,
          desiredAnchor: original.anchor,
          expectedAnchor: current.anchor,
        });
        yield* recovered.activate;
        yield* recovered.operations.applyAnchor(threadId, original.anchor);
        yield* recovered.operations.releaseAnchor(threadId, original.anchor);
        NodeAssert.deepEqual(h.histories.get(h.selected)?.turns, [turn("one")]);
        NodeAssert.equal((yield* capture(recovered, source("one", 1))).digest, original.digest);
      }),
  );
  it.effect("compaction cannot use an old receipt or incomplete/non-compaction native tail", () =>
    Effect.gen(function* () {
      const h = harness([turn("one")]);
      yield* h.controller.recordCompleted("one");
      yield* capture(h.controller, checkpoint("one", 1));
      yield* h.controller.beforeCompaction;
      h.controller.compactionReceipt("one");
      yield* h.controller.finishCompaction();
      NodeAssert.equal(h.controller.cursor(), undefined);
      h.setTurns([turn("one"), turn("not-compaction")]);
      h.controller.compactionReceipt("not-compaction");
      NodeAssert.ok(Exit.isFailure(yield* Effect.exit(h.controller.finishCompaction())));
      NodeAssert.equal(h.controller.cursor(), undefined);
    }),
  );
  it.effect(
    "normal resume after compaction preserves both current and original immutable histories",
    () =>
      Effect.gen(function* () {
        const h = harness([turn("one")]);
        yield* h.controller.recordCompleted("one");
        const original = yield* capture(h.controller, checkpoint("one", 1));
        yield* h.controller.beforeCompaction;
        h.setTurns([
          turn("one"),
          {
            id: "compact-1",
            status: "completed",
            itemsView: "full",
            items: [{ id: "compact-item", type: "contextCompaction" }],
          },
        ]);
        h.controller.compactionReceipt("compact-1");
        yield* h.controller.finishCompaction();
        const previous = readCodexExactCursor(h.controller.cursor());
        NodeAssert.ok(previous);
        const resumed = h.make({ incarnation: RuntimeSessionId.make("new-incarnation") });
        yield* resumed.initialize(previous);
        NodeAssert.ok(readCodexExactCursor(resumed.cursor()));
        NodeAssert.equal((yield* capture(resumed, checkpoint("one", 1))).digest, original.digest);
        NodeAssert.equal(
          (yield* capture(resumed, source("one", 1))).digest,
          previous.exactRollback.anchor.digest,
        );
      }),
  );
  it.effect("rejects busy and retired owners and never accepts a malformed private cursor", () =>
    Effect.gen(function* () {
      const { h } = yield* twoTurns();
      const cursor = h.controller.cursor();
      NodeAssert.ok(cursor);
      NodeAssert.equal(readCodexExactCursor({ threadId: h.selected }), undefined);
      NodeAssert.equal(
        readCodexExactCursor({
          ...cursor,
          exactRollback: {
            ...cursor.exactRollback,
            anchor: { ...cursor.exactRollback.anchor, digest: "changed" },
          },
        }),
        undefined,
      );
      h.setIdle(false);
      NodeAssert.equal(yield* h.controller.operations.isAvailable(threadId), false);
      NodeAssert.ok(
        Exit.isFailure(yield* Effect.exit(h.controller.operations.inspectAnchor(threadId))),
      );
      h.setIdle(true);
      h.retire();
      NodeAssert.ok(
        Exit.isFailure(yield* Effect.exit(h.controller.operations.inspectAnchor(threadId))),
      );
    }),
  );
});
