import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type RuntimeSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderAdapterValidationError, type ProviderAdapterError } from "../Errors.ts";
import type {
  ProviderAbsoluteConversationRollback,
  ProviderConversationAnchorBinding,
  ProviderConversationAnchorReceipt,
} from "../Services/ProviderAdapter.ts";
import type { CodexSessionRuntimeShape } from "./CodexSessionRuntime.ts";
import { codexConversationDigest, type CodexConversationSnapshot } from "./CodexAbsoluteHistory.ts";

const Snapshot = Schema.Struct({
  threadId: Schema.String,
  cwd: Schema.String,
  turns: Schema.Array(Schema.Json),
  nativeRecords: Schema.Array(Schema.Json),
  nativeGoal: Schema.Json,
  rolloutPath: Schema.String,
});
const Anchor = Schema.Struct({
  version: Schema.Literal(1),
  provider: Schema.Literal("codex-exact"),
  providerInstanceId: Schema.String,
  sessionIncarnationId: Schema.String,
  pylonThreadId: Schema.String,
  cwd: Schema.String,
  snapshot: Snapshot,
  digest: Schema.String,
  binding: Schema.optionalKey(Schema.Json),
  compactionCheckpoint: Schema.optionalKey(Snapshot),
  compactionTurnId: Schema.optionalKey(Schema.String),
});
const Cursor = Schema.Struct({
  threadId: Schema.String,
  exactRollback: Schema.Struct({ selectedThreadId: Schema.String, anchor: Anchor }),
});
export type CodexExactCursor = typeof Cursor.Type;
const isCursor = Schema.is(Cursor);
const isAnchor = Schema.is(Anchor);
const coherentSnapshots = (anchor: typeof Anchor.Type) =>
  anchor.snapshot.cwd === anchor.cwd &&
  anchor.snapshot.rolloutPath.length > 0 &&
  anchor.snapshot.nativeRecords.length > 0 &&
  codexConversationDigest(anchor.snapshot) === anchor.digest &&
  ((anchor.compactionCheckpoint === undefined && anchor.compactionTurnId === undefined) ||
    (anchor.compactionCheckpoint !== undefined &&
      anchor.compactionTurnId !== undefined &&
      anchor.compactionCheckpoint.cwd === anchor.cwd &&
      anchor.compactionCheckpoint.rolloutPath.length > 0 &&
      anchor.compactionCheckpoint.nativeRecords.length > 0 &&
      anchor.compactionCheckpoint.threadId !== anchor.snapshot.threadId));

/** Only the private directory's complete idle proof is eligible for same-incarnation adoption. */
export const readCodexExactCursor = (raw: unknown): CodexExactCursor | undefined =>
  isCursor(raw) &&
  raw.threadId.length > 0 &&
  raw.threadId === raw.exactRollback.selectedThreadId &&
  raw.threadId !== raw.exactRollback.anchor.snapshot.threadId &&
  raw.exactRollback.anchor.snapshot.threadId.length > 0 &&
  raw.exactRollback.anchor.snapshot.cwd === raw.exactRollback.anchor.cwd &&
  raw.exactRollback.anchor.providerInstanceId.length > 0 &&
  raw.exactRollback.anchor.sessionIncarnationId.length > 0 &&
  raw.exactRollback.anchor.pylonThreadId.length > 0 &&
  coherentSnapshots(raw.exactRollback.anchor)
    ? raw
    : undefined;

export function makeCodexAbsoluteRollback(input: {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly incarnationId: RuntimeSessionId | undefined;
  readonly cwd: string;
  readonly runtime: Pick<CodexSessionRuntimeShape, "absoluteConversation">;
  readonly requireCurrent: Effect.Effect<void, ProviderAdapterError>;
  readonly recovering: boolean;
}) {
  let recoveryHeld = input.recovering;
  let rollbackHeld = false;
  let outputEpoch = 0;
  let source: typeof Anchor.Type | undefined;
  let target: typeof Anchor.Type | undefined;
  let proof: CodexExactCursor | undefined;
  let root: typeof Anchor.Type | undefined;
  const completed = new Map<string, typeof Anchor.Type>();
  const compacted = new Map<string | null, typeof Anchor.Type>();
  let compactionInFlight = false;
  let pendingCompaction:
    | {
        selectedThreadId: string;
        checkpointTurnId: string | null;
        anchor: typeof Anchor.Type;
        before: CodexConversationSnapshot;
        receiptTurnId?: string;
      }
    | undefined;
  const held = () => recoveryHeld || rollbackHeld;
  const invalid = (issue: string) =>
    new ProviderAdapterValidationError({
      provider: ProviderDriverKind.make("codex"),
      operation: "absoluteConversationRollback",
      issue,
    });
  const native = input.runtime.absoluteConversation;
  const requireIdle = Effect.gen(function* () {
    yield* input.requireCurrent;
    if (!native || !input.incarnationId || !(yield* native.isIdle)) {
      return yield* invalid(
        "Exact Codex rollback needs a current, idle session with an incarnation and complete native history.",
      );
    }
    return native;
  });
  const read = Effect.fn("CodexAbsoluteRollback.read")(function* (threadId?: string) {
    const runtime = yield* requireIdle;
    const snapshot = yield* runtime
      .read(threadId)
      .pipe(Effect.mapError(() => invalid("The exact Codex conversation could not be verified.")));
    yield* input.requireCurrent;
    return snapshot;
  });
  const verifyAnchor = (raw: unknown) =>
    Effect.gen(function* () {
      if (
        !isAnchor(raw) ||
        raw.providerInstanceId !== input.instanceId ||
        raw.sessionIncarnationId !== input.incarnationId ||
        raw.pylonThreadId !== input.threadId ||
        raw.cwd !== input.cwd ||
        raw.snapshot.cwd !== input.cwd ||
        !coherentSnapshots(raw)
      ) {
        return yield* invalid("The private Codex rollback identity or snapshot is invalid.");
      }
      return raw;
    });
  const anchorFor = (
    snapshot: CodexConversationSnapshot,
    binding?: ProviderConversationAnchorBinding,
  ): typeof Anchor.Type => ({
    version: 1,
    provider: "codex-exact",
    providerInstanceId: input.instanceId,
    sessionIncarnationId: input.incarnationId!,
    pylonThreadId: input.threadId,
    cwd: input.cwd,
    snapshot,
    digest: codexConversationDigest(snapshot),
    ...(binding ? { binding: { ...binding } } : {}),
  });
  const receipt = (anchor: typeof Anchor.Type): ProviderConversationAnchorReceipt => ({
    anchor,
    digest: anchor.digest,
  });
  const remember = (snapshot: CodexConversationSnapshot, anchor: typeof Anchor.Type) => {
    proof = {
      threadId: snapshot.threadId,
      exactRollback: { selectedThreadId: snapshot.threadId, anchor },
    };
  };
  const fork = Effect.fn("CodexAbsoluteRollback.fork")(function* (
    snapshot: CodexConversationSnapshot,
    lastTurnId?: string,
  ) {
    const runtime = yield* requireIdle;
    const result = yield* runtime
      .fork({ source: snapshot, ...(lastTurnId === undefined ? {} : { lastTurnId }) })
      .pipe(
        Effect.mapError(() =>
          invalid("The immutable Codex conversation snapshot could not be verified."),
        ),
      );
    yield* input.requireCurrent;
    return result;
  });
  const inspect = Effect.fn("CodexAbsoluteRollback.inspect")(function* () {
    const current = yield* read();
    const digest = codexConversationDigest(current);
    const known = [source, target, proof?.exactRollback.anchor].find(
      (anchor) => anchor?.digest === digest,
    );
    if (!known)
      return yield* invalid(
        "The selected Codex conversation is outside the verified rollback boundary.",
      );
    // Inspect can finish a selection that succeeded before its caller failed. Publish routing
    // proof here as well, so the saga cannot verify a target while persisting a stale source.
    const immutable = yield* read(known.snapshot.threadId);
    if (codexConversationDigest(immutable) !== known.digest)
      return yield* invalid("The private Codex snapshot changed.");
    remember(current, known);
    return receipt(known);
  });
  const completedTail = (snapshot: CodexConversationSnapshot, turnId: string) => {
    const last = snapshot.turns.at(-1);
    return (
      last !== null &&
      typeof last === "object" &&
      "id" in last &&
      last?.id === turnId &&
      last.status === "completed"
    );
  };
  const originalCheckpoint = (anchor: typeof Anchor.Type): typeof Anchor.Type => {
    const { compactionCheckpoint, compactionTurnId: _compactionTurnId, ...plain } = anchor;
    return compactionCheckpoint
      ? {
          ...plain,
          snapshot: compactionCheckpoint,
          digest: codexConversationDigest(compactionCheckpoint),
        }
      : plain;
  };
  const retainBinding = (anchor: typeof Anchor.Type) => {
    const binding = anchor.binding;
    if (!binding || typeof binding !== "object" || !("kind" in binding) || !("turnId" in binding))
      return false;
    if (binding.kind !== "checkpoint" && binding.kind !== "source") return false;
    const original = originalCheckpoint(anchor);
    if (
      anchor.compactionTurnId !== undefined &&
      !completedTail(anchor.snapshot, anchor.compactionTurnId)
    )
      return false;
    if (binding.turnId === null && original.snapshot.turns.length === 0) {
      root = original;
      if (anchor.compactionCheckpoint) compacted.set(null, anchor);
      return true;
    }
    if (typeof binding.turnId === "string" && completedTail(original.snapshot, binding.turnId)) {
      completed.set(binding.turnId, original);
      if (anchor.compactionCheckpoint) compacted.set(binding.turnId, anchor);
      return true;
    }
    return false;
  };
  const beforeCompaction = Effect.gen(function* () {
    yield* input.requireCurrent;
    if (held()) return yield* invalid("Codex input is held until exact recovery is released.");
    const previous = proof?.exactRollback.anchor;
    proof = undefined;
    pendingCompaction = undefined;
    compactionInFlight = true;
    yield* Effect.gen(function* () {
      const current = yield* read();
      const digest = codexConversationDigest(current);
      const known = [previous, root, ...completed.values(), ...compacted.values()].find(
        (anchor) => anchor?.digest === digest,
      );
      if (!known) return;
      const original = originalCheckpoint(known);
      const tail = original.snapshot.turns.at(-1);
      const checkpointTurnId =
        original.snapshot.turns.length === 0
          ? null
          : tail !== null && typeof tail === "object" && "id" in tail && typeof tail.id === "string"
            ? tail.id
            : undefined;
      if (checkpointTurnId === undefined) return;
      pendingCompaction = {
        selectedThreadId: current.threadId,
        checkpointTurnId,
        anchor: known,
        before: current,
      };
    }).pipe(Effect.ignore);
  });
  const compactionReceipt = (turnId: string) => {
    if (
      pendingCompaction &&
      !pendingCompaction.before.turns.some(
        (turn) => turn !== null && typeof turn === "object" && "id" in turn && turn.id === turnId,
      )
    ) {
      pendingCompaction.receiptTurnId = turnId;
    }
  };
  const finishCompaction = Effect.fn("CodexAbsoluteRollback.finishCompaction")(function* () {
    const pending = pendingCompaction;
    if (!pending?.receiptTurnId) return;
    const current = yield* read();
    if (
      current.threadId !== pending.selectedThreadId ||
      !completedTail(current, pending.receiptTurnId)
    )
      return yield* invalid("Codex compaction has no exact completed native receipt.");
    const tail = current.turns.at(-1);
    if (
      !tail ||
      typeof tail !== "object" ||
      !("items" in tail) ||
      !Array.isArray(tail.items) ||
      !tail.items.some(
        (item: unknown) =>
          item !== null &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "contextCompaction",
      )
    )
      return yield* invalid("The completed Codex receipt has no native compaction item.");
    const original = originalCheckpoint(pending.anchor);
    const immutable = yield* read(original.snapshot.threadId);
    if (codexConversationDigest(immutable) !== original.digest)
      return yield* invalid("The original Codex checkpoint changed during compaction.");
    const snapshot = yield* fork(current);
    const anchor = {
      ...anchorFor(snapshot),
      ...(pending.anchor.binding ? { binding: pending.anchor.binding } : {}),
      compactionCheckpoint: original.snapshot,
      compactionTurnId: pending.receiptTurnId,
    };
    compacted.set(pending.checkpointTurnId, anchor);
    if (anchor.binding) remember(current, anchor);
    pendingCompaction = undefined;
    compactionInFlight = false;
  });
  // The event consumer records an immutable full history before publishing a Pylon completion.
  // Later source capture compares this digest, so an external edit cannot masquerade as that turn.
  const recordCompleted = Effect.fn("CodexAbsoluteRollback.recordCompleted")(function* (
    turnId: string,
  ) {
    yield* requireIdle;
    if (held()) return yield* invalid("Codex completion is held during exact recovery.");
    return yield* Effect.gen(function* () {
      const current = yield* read();
      if (!completedTail(current, turnId))
        return yield* invalid("The completed Codex turn is not the authoritative history tail.");
      const existing = completed.get(turnId);
      if (existing) {
        const immutable = yield* read(existing.snapshot.threadId);
        if (
          codexConversationDigest(current) !== existing.digest ||
          codexConversationDigest(immutable) !== existing.digest
        )
          return yield* invalid(
            "A repeated Codex completion changed its original immutable history.",
          );
        return;
      }
      const snapshot = yield* fork(current);
      completed.set(turnId, anchorFor(snapshot));
    });
  });
  const initialize = Effect.fn("CodexAbsoluteRollback.initialize")(function* (
    previous?: CodexExactCursor,
  ) {
    yield* requireIdle;
    return yield* Effect.gen(function* () {
      const current = yield* read();
      if (current.turns.length === 0) {
        root = anchorFor(yield* fork(current));
        return;
      }
      // An ordinary Stop/resume gets a new incarnation. It retains the selected native history,
      // but may only rebind old checkpoint eligibility after both histories are verified.
      const old = previous?.exactRollback.anchor;
      if (
        !old ||
        previous.threadId !== current.threadId ||
        old.providerInstanceId !== input.instanceId ||
        old.pylonThreadId !== input.threadId ||
        old.cwd !== input.cwd ||
        codexConversationDigest(current) !== old.digest
      )
        return;
      const immutable = yield* read(old.snapshot.threadId);
      if (codexConversationDigest(immutable) !== old.digest) return;
      if (old.compactionCheckpoint) {
        const original = yield* read(old.compactionCheckpoint.threadId);
        if (codexConversationDigest(original) !== codexConversationDigest(old.compactionCheckpoint))
          return;
      }
      const snapshot = yield* fork(current);
      const rebound = {
        ...anchorFor(snapshot),
        ...(old.binding ? { binding: old.binding } : {}),
        ...(old.compactionCheckpoint
          ? {
              compactionCheckpoint: old.compactionCheckpoint,
              compactionTurnId: old.compactionTurnId,
            }
          : {}),
      };
      if (retainBinding(rebound)) remember(current, rebound);
    });
  });
  const operations: ProviderAbsoluteConversationRollback<ProviderAdapterError> = {
    isAvailable: () =>
      requireIdle.pipe(
        Effect.map(
          () =>
            !compactionInFlight &&
            (root !== undefined || completed.size > 0 || proof !== undefined),
        ),
        Effect.orElseSucceed(() => false),
      ),
    captureAnchor: ({ binding }) =>
      Effect.gen(function* () {
        const runtime = yield* requireIdle;
        if (compactionInFlight)
          return yield* invalid("Codex compaction has not reached a verified idle completion.");
        if (
          binding.kind === "checkpoint" &&
          (binding.sourceRevision !== binding.checkpointTurnCount ||
            (binding.checkpointTurnCount === 0) !== (binding.turnId === null))
        )
          return yield* invalid("The exact Codex checkpoint binding is invalid.");
        if (binding.kind === "source") {
          rollbackHeld = true;
          outputEpoch += 1;
          yield* runtime.quarantine(true);
        }
        return yield* Effect.gen(function* () {
          const current = yield* read();
          const checkpoint = binding.turnId === null ? root : completed.get(binding.turnId);
          const known =
            binding.kind === "source"
              ? [compacted.get(binding.turnId), checkpoint].find(
                  (anchor) => anchor?.digest === codexConversationDigest(current),
                )
              : checkpoint;
          if (!known)
            return yield* invalid("This Pylon turn has no verified immutable Codex checkpoint.");
          const immutable = yield* read(known.snapshot.threadId);
          if (codexConversationDigest(immutable) !== known.digest)
            return yield* invalid("The private Codex checkpoint changed.");
          const anchor = { ...known, binding: { ...binding } };
          if (binding.kind === "source") {
            if (codexConversationDigest(current) !== known.digest)
              return yield* invalid(
                "The current Codex history differs from Pylon's recorded completed turn.",
              );
            source = anchor;
            target = undefined;
            remember(current, anchor);
          } else if (codexConversationDigest(current) === anchor.digest) {
            remember(current, anchor);
          }
          return receipt(anchor);
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              binding.kind === "source" ? runtime.quarantine(held()) : Effect.void,
            ),
          ),
        );
      }),
    inspectAnchor: () => inspect(),
    applyAnchor: (_threadId, raw) =>
      Effect.gen(function* () {
        const runtime = yield* requireIdle;
        const desired = yield* verifyAnchor(raw);
        if (!rollbackHeld || !source)
          return yield* invalid("An exact Codex source must be captured before applying a target.");
        const current = yield* inspect();
        const previousTarget = target;
        if (desired.digest !== source.digest) target = desired;
        if (
          current.digest !== source.digest &&
          current.digest !== previousTarget?.digest &&
          current.digest !== desired.digest
        ) {
          return yield* invalid("Codex moved outside the exact source and target.");
        }
        yield* runtime.quarantine(true);
        const immutable = yield* read(desired.snapshot.threadId);
        if (codexConversationDigest(immutable) !== desired.digest)
          return yield* invalid("The desired private Codex snapshot changed.");
        if (current.digest === desired.digest) return;
        // Selecting a new fork makes retries idempotent and leaves both recovery snapshots intact.
        const selected = yield* fork(immutable);
        yield* runtime
          .select(selected)
          .pipe(Effect.mapError(() => invalid("Selecting the exact Codex conversation failed.")));
        yield* input.requireCurrent;
        remember(selected, desired);
        const verified = yield* inspect();
        if (verified.digest !== desired.digest)
          return yield* invalid("The selected Codex target could not be verified.");
      }),
    prepareRecovery: ({ sourceAnchor, desiredAnchor, expectedAnchor }) =>
      Effect.gen(function* () {
        const runtime = yield* requireIdle;
        const restoredSource = yield* verifyAnchor(sourceAnchor);
        const restoredTarget = yield* verifyAnchor(desiredAnchor);
        const expected = yield* verifyAnchor(expectedAnchor);
        if (expected.digest !== restoredSource.digest && expected.digest !== restoredTarget.digest)
          return yield* invalid("The recovered Codex boundary is invalid.");
        rollbackHeld = true;
        outputEpoch += 1;
        yield* runtime.quarantine(true);
        source = restoredSource;
        target = restoredTarget;
        const current = yield* inspect();
        if (current.digest !== expected.digest)
          return yield* invalid("The recovered Codex owner is not at its expected exact snapshot.");
      }),
    releaseAnchor: (_threadId, raw) =>
      Effect.gen(function* () {
        const runtime = yield* requireIdle;
        const expected = yield* verifyAnchor(raw);
        const actual = yield* inspect();
        if (actual.digest !== expected.digest)
          return yield* invalid("The exact Codex release snapshot does not match.");
        rollbackHeld = false;
        outputEpoch += 1;
        source = undefined;
        target = undefined;
        yield* runtime.quarantine(held());
      }),
  };
  return {
    operations,
    initialize,
    recordCompleted,
    beforeCompaction,
    compactionReceipt,
    finishCompaction,
    outputAllowed: () => !held(),
    outputEpoch: () => outputEpoch,
    cursor: () => proof,
    invalidate: () => {
      proof = undefined;
    },
    beforeMutation: Effect.gen(function* () {
      yield* input.requireCurrent;
      if (held()) return yield* invalid("Codex input is held until exact recovery is released.");
      proof = undefined;
      pendingCompaction = undefined;
      compactionInFlight = false;
    }),
    recover: (cursor: CodexExactCursor) =>
      Effect.gen(function* () {
        const anchor = yield* verifyAnchor(cursor.exactRollback.anchor);
        const selected = yield* read();
        const immutable = yield* read(anchor.snapshot.threadId);
        if (
          selected.threadId !== cursor.threadId ||
          codexConversationDigest(selected) !== anchor.digest ||
          codexConversationDigest(immutable) !== anchor.digest
        )
          return yield* invalid("The private Codex idle recovery proof no longer matches.");
        if (anchor.compactionCheckpoint) {
          const original = yield* read(anchor.compactionCheckpoint.threadId);
          if (
            codexConversationDigest(original) !==
            codexConversationDigest(anchor.compactionCheckpoint)
          )
            return yield* invalid("The original Codex checkpoint recovery snapshot changed.");
        }
        if (!retainBinding(anchor))
          return yield* invalid("The recovered Codex proof has no completed Pylon turn binding.");
        remember(selected, anchor);
      }),
    activate: Effect.gen(function* () {
      const runtime = yield* requireIdle;
      recoveryHeld = false;
      outputEpoch += 1;
      yield* runtime.quarantine(held());
    }),
  };
}
