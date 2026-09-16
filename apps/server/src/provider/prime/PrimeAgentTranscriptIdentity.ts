// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type { PrimeDaemonMessage } from "./PrimeAgentDaemonEvents.ts";

export function legacyPrimeDaemonMessageFingerprint(message: PrimeDaemonMessage): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(message), "utf8").digest("hex");
}

export function primeDaemonMessageFingerprint(message: PrimeDaemonMessage): string {
  if (message.role !== "assistant") return legacyPrimeDaemonMessageFingerprint(message);
  // Child usage attribution can update historical assistant accounting after message_end.
  // Version the persisted identity so old ledger hashes still require exact legacy proof.
  const { usage: _usage, ...identity } = message;
  return `transcript-v2:${NodeCrypto.createHash("sha256")
    .update(JSON.stringify(identity), "utf8")
    .digest("hex")}`;
}

export function primeDaemonMessageMatchesFingerprint(
  message: PrimeDaemonMessage,
  expected: string,
): boolean {
  return (
    (expected.startsWith("transcript-v2:")
      ? primeDaemonMessageFingerprint(message)
      : legacyPrimeDaemonMessageFingerprint(message)) === expected
  );
}

/** Bounded structural diagnostics only: never include transcript values or content hashes. */
export function primeTranscriptMismatchDetails(input: {
  readonly observed: ReadonlyArray<PrimeDaemonMessage>;
  readonly observedCount: number;
  readonly snapshot: ReadonlyArray<PrimeDaemonMessage>;
  readonly snapshotCount: number;
}) {
  const observedStart = input.observedCount - input.observed.length;
  const snapshotStart = input.snapshotCount - input.snapshot.length;
  for (
    let index = Math.max(observedStart, snapshotStart);
    index < Math.min(input.observedCount, input.snapshotCount);
    index++
  ) {
    const observed = input.observed[index - observedStart];
    const snapshot = input.snapshot[index - snapshotStart];
    if (observed === undefined || snapshot === undefined) break;
    if (primeDaemonMessageFingerprint(observed) === primeDaemonMessageFingerprint(snapshot))
      continue;
    const snapshotFields = new Map(Object.entries(snapshot));
    const observedFields = new Map(Object.entries(observed));
    const changedFields = [...new Set([...observedFields.keys(), ...snapshotFields.keys()])].filter(
      (key) =>
        key !== "usage" &&
        JSON.stringify(observedFields.get(key)) !== JSON.stringify(snapshotFields.get(key)),
    );
    return {
      mismatchIndex: index,
      observedRole: observed.role,
      snapshotRole: snapshot.role,
      changedFields,
    };
  }
  return {};
}
