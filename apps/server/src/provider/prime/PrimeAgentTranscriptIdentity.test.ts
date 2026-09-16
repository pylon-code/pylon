import { describe, expect, it } from "@effect/vitest";
import type { PrimeDaemonMessage } from "./PrimeAgentDaemonEvents.ts";
import {
  legacyPrimeDaemonMessageFingerprint,
  primeDaemonMessageFingerprint,
  primeTranscriptMismatchDetails,
} from "./PrimeAgentTranscriptIdentity.ts";
import { planPrimeAgentRestartReplay } from "./PrimeAgentDaemonAdapter.ts";

const original = {
  role: "assistant",
  timestamp: 1,
  provider: "prime",
  model: "model",
  responseId: "response",
  text: "private text",
  thinking: "private reasoning",
  toolCalls: [{ id: "tool-1", name: "read", input: { path: "private" } }],
  usage: {
    inputTokens: 1,
    outputTokens: 2,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 3,
    totalCostUsd: 0.1,
  },
  stopReason: "toolUse",
} satisfies PrimeDaemonMessage;
const updated = { ...original, usage: { ...original.usage, totalTokens: 99, totalCostUsd: 1 } };
const replay = (authority: string, snapshot: PrimeDaemonMessage) =>
  planPrimeAgentRestartReplay({
    authorityMessageCount: 1,
    authorityFingerprints: [authority],
    snapshotMessageCount: 1,
    snapshotMessages: [snapshot],
  });

describe("Prime transcript identity", () => {
  it("preserves restart continuity across historical child usage attribution", () => {
    expect(primeDaemonMessageFingerprint(updated)).toBe(primeDaemonMessageFingerprint(original));
    expect(replay(primeDaemonMessageFingerprint(original), updated)).toEqual({
      valid: true,
      backlog: [],
    });
  });
  it("accepts unchanged legacy ledgers but never guesses identity after accounting changed", () => {
    expect(replay(legacyPrimeDaemonMessageFingerprint(original), original)).toEqual({
      valid: true,
      backlog: [],
    });
    expect(replay(legacyPrimeDaemonMessageFingerprint(original), updated)).toEqual({
      valid: false,
    });
  });
  it("still rejects changes to every stable assistant field", () => {
    for (const changed of [
      { ...updated, text: "different" },
      { ...updated, thinking: "different" },
      { ...updated, timestamp: 2 },
      { ...updated, responseId: "different" },
      { ...updated, provider: "different" },
      { ...updated, model: "different" },
      { ...updated, toolCalls: [] },
      { ...updated, stopReason: "stop" as const },
      { ...updated, errorMessage: "different" },
    ])
      expect(replay(primeDaemonMessageFingerprint(original), changed)).toEqual({ valid: false });
  });
  it("logs the absolute mismatch position and field names without private values", () => {
    expect(
      primeTranscriptMismatchDetails({
        observed: [original],
        observedCount: 100,
        snapshot: [{ ...updated, text: "changed private text" }],
        snapshotCount: 100,
      }),
    ).toEqual({
      mismatchIndex: 99,
      observedRole: "assistant",
      snapshotRole: "assistant",
      changedFields: ["text"],
    });
    expect(
      primeTranscriptMismatchDetails({
        observed: [original],
        observedCount: 1,
        snapshot: [updated],
        snapshotCount: 1,
      }),
    ).toEqual({});
  });
});
