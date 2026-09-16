import { primeDaemonMessageFingerprint } from "./PrimeAgentTranscriptIdentity.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import nativeFixture from "./fixtures/native-compaction/isolated-manual.json" with { type: "json" };
import legacyFixture from "./fixtures/native-compaction/legacy-timestamp-mismatch.json" with { type: "json" };
import { decodePrimeAgentDaemonMessage } from "./PrimeAgentDaemonEvents.ts";
import {
  decodePrimeCompactionHistory,
  planPrimeCompactionReplacement,
} from "./PrimeAgentCompactionHistory.ts";
import { planPrimeAgentRestartReplay } from "./PrimeAgentDaemonAdapter.ts";

const timestamp = "2026-09-14T12:00:00.000Z";
const nativeUser = (text: string, time: number) => ({
  role: "user",
  content: text,
  timestamp: time,
});
const fingerprint = (message: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(message)).digest("hex");
const entry = <T extends Record<string, unknown>>(
  id: string,
  parentId: string | null,
  fields: T,
) => ({
  id,
  parentId,
  timestamp,
  ...fields,
});
const chain = (entries: ReadonlyArray<Record<string, unknown>>): unknown =>
  entries.reduceRight<unknown[]>((children, value) => [{ entry: value, children }], []);
const first = entry("a", null, { type: "message", message: nativeUser("old", 1) });
const retained = entry("b", "a", { type: "message", message: nativeUser("kept", 2) });
const compact = entry("c", "b", {
  type: "compaction",
  firstKeptEntryId: "b",
  summary: "private summary",
  tokensBefore: 500,
  harnessDigest: "private memory",
});
const post = entry("d", "c", { type: "message", message: nativeUser("after", 3) });
const tree = (
  entries: ReadonlyArray<Record<string, unknown>> = [first, retained, compact, post],
  leafId = "d",
) => ({
  tree: chain(entries),
  leafId,
});
const decode = (value: unknown, leafId = "d") =>
  decodePrimeCompactionHistory(value, leafId, decodePrimeAgentDaemonMessage);
const requireHistory = () => {
  const history = decode(tree());
  if (history === undefined) throw new Error("missing history");
  return history;
};

describe("compaction history proof", () => {
  it("proves compaction with versioned or mixed legacy identities after usage attribution", () => {
    const history = decodePrimeCompactionHistory(
      nativeFixture.tree,
      nativeFixture.tree.leafId,
      decodePrimeAgentDaemonMessage,
    );
    if (history === undefined) throw new Error("missing fixture history");
    expect(history.previous.some((message) => message.role === "assistant")).toBe(true);
    const previous = history.previous.map((message) =>
      message.role === "assistant"
        ? { ...message, usage: { ...message.usage, totalTokens: message.usage.totalTokens + 100 } }
        : message,
    );
    expect(
      planPrimeAgentRestartReplay({
        authorityMessageCount: previous.length,
        authorityFingerprints: previous.map(primeDaemonMessageFingerprint),
        snapshotMessageCount: history.current.length,
        snapshotMessages: history.current,
        compactionHistory: history,
      }),
    ).toEqual({ valid: true, backlog: [] });
    expect(
      planPrimeAgentRestartReplay({
        authorityMessageCount: history.previous.length,
        authorityFingerprints: history.previous.map((message, index) =>
          index % 2 === 0 ? fingerprint(message) : primeDaemonMessageFingerprint(message),
        ),
        snapshotMessageCount: history.current.length,
        snapshotMessages: history.current,
        compactionHistory: history,
      }),
    ).toEqual({ valid: true, backlog: [] });
  });

  it("proves a real Prime faux-provider compaction captured from the public session tree", () => {
    // Captured from Prime 72e4e9fbb (issue #76 timestamp fix): two persisted prompts, then session.compact(),
    // using suite/harness.ts with faux responses, auto-refine disabled and keepRecentTokens=1.
    const history = decodePrimeCompactionHistory(
      nativeFixture.tree,
      nativeFixture.tree.leafId,
      decodePrimeAgentDaemonMessage,
    );
    const messages = (values: ReadonlyArray<unknown>) =>
      values.map((value) => {
        const message = decodePrimeAgentDaemonMessage(value);
        if (message === undefined) throw new Error("unsupported fixture message");
        return message;
      });
    const before = messages(nativeFixture.before);
    const after = messages(nativeFixture.after);
    expect(history?.previous).toEqual(before);
    expect(history?.current).toEqual(after);
    expect(
      planPrimeAgentRestartReplay({
        authorityMessageCount: before.length,
        authorityFingerprints: before.map(fingerprint),
        snapshotMessageCount: after.length,
        snapshotMessages: after,
        compactionHistory: history,
      }),
    ).toEqual({ valid: true, backlog: [] });
  });

  it("does not excuse the real legacy custom timestamp mismatch during compaction", () => {
    const history = decodePrimeCompactionHistory(
      legacyFixture.tree,
      legacyFixture.tree.leafId,
      decodePrimeAgentDaemonMessage,
    );
    const before = legacyFixture.before.map(decodePrimeAgentDaemonMessage);
    const after = legacyFixture.after.map((value) => {
      const message = decodePrimeAgentDaemonMessage(value);
      if (message === undefined) throw new Error("unsupported legacy fixture message");
      return message;
    });
    expect(
      planPrimeAgentRestartReplay({
        authorityMessageCount: before.length,
        authorityFingerprints: before.map(fingerprint),
        snapshotMessageCount: after.length,
        snapshotMessages: after,
        compactionHistory: history,
      }),
    ).toEqual({ valid: false });
  });

  it("reconstructs the exact retained boundary and private summary", () => {
    const history = requireHistory();
    expect(history.previous).toEqual([
      decodePrimeAgentDaemonMessage(first.message),
      decodePrimeAgentDaemonMessage(retained.message),
    ]);
    expect(history.current).toEqual([
      decodePrimeAgentDaemonMessage({
        role: "compactionSummary",
        summary: compact.summary,
        tokensBefore: compact.tokensBefore,
        harnessDigest: compact.harnessDigest,
        retainedMessageCount: 1,
        timestamp: Date.parse(timestamp),
      }),
      decodePrimeAgentDaemonMessage(retained.message),
      decodePrimeAgentDaemonMessage(post.message),
    ]);
    expect(JSON.stringify(history)).not.toContain("private");
    for (const observed of [history.previous, [...history.previous, ...history.appended]]) {
      const planned = planPrimeCompactionReplacement({
        history,
        observedCount: observed.length,
        observedFingerprints: observed.map(fingerprint),
        snapshotCount: history.current.length,
        snapshot: history.current,
        fingerprint,
      });
      expect(planned).toMatchObject({
        observedCount: observed.length,
        previousCount: 2,
        retainedCount: 1,
      });
    }
  });

  it("rejects malformed, cyclic, duplicated, foreign and unknown history", () => {
    for (const value of [
      tree([first, retained, compact, post], "foreign"),
      tree([first, { ...retained, parentId: "foreign" }, compact, post]),
      tree([first, { ...retained, id: "a" }, compact, post]),
      tree([first, retained, { ...compact, firstKeptEntryId: "foreign" }, post]),
      tree([first, retained, { ...compact, firstKeptEntryId: "d" }, post]),
      tree([first, retained, { ...compact, timestamp: "invalid" }, post]),
      tree([first, retained, compact, { ...post, type: "unknown" }]),
      tree([
        first,
        retained,
        compact,
        {
          ...post,
          type: "message",
          message: {
            role: "custom",
            customType: "heartbeat_prompt",
            content: "foreign",
            timestamp: 3,
            display: true,
          },
        },
      ]),
      { leafId: "d", tree: Array.from({ length: 8193 }, () => ({ entry: first, children: [] })) },
    ])
      expect(decode(value)).toBeUndefined();
  });

  it("rejects changed old, retained, summary and current history and incorrect counts", () => {
    const history = requireHistory();
    const input = {
      history,
      observedCount: history.previous.length,
      observedFingerprints: history.previous.map(fingerprint),
      snapshotCount: history.current.length,
      snapshot: history.current,
      fingerprint,
    };
    for (const changed of [
      { ...input, observedCount: 1, observedFingerprints: [fingerprint(history.previous[0])] },
      { ...input, observedFingerprints: input.observedFingerprints.toReversed() },
      { ...input, observedFingerprints: ["changed", input.observedFingerprints[1]!] },
      { ...input, snapshot: history.current.toReversed() },
      { ...input, snapshotCount: 99 },
      {
        ...input,
        snapshot: history.current.map((message, index) =>
          index === 0 ? { ...message, timestamp: 99 } : message,
        ),
      },
      {
        ...input,
        snapshot: history.current.map((message, index) =>
          index === 1 ? { ...message, timestamp: 99 } : message,
        ),
      },
    ])
      expect(planPrimeCompactionReplacement(changed)).toBeUndefined();
  });

  it("recovers a shorter context across restart only with a matching history proof", () => {
    const extra = entry("a2", "a", { type: "message", message: nativeUser("also old", 1.5) });
    const history = decode(
      tree([first, extra, { ...retained, parentId: "a2" }, compact], "c"),
      "c",
    );
    if (history === undefined) throw new Error("missing shorter history");
    const input = {
      authorityMessageCount: history.previous.length,
      authorityFingerprints: history.previous.map(fingerprint),
      snapshotMessageCount: history.current.length,
      snapshotMessages: history.current,
    };
    expect(planPrimeAgentRestartReplay(input)).toEqual({ valid: false });
    expect(planPrimeAgentRestartReplay({ ...input, compactionHistory: history })).toEqual({
      valid: true,
      backlog: [],
    });
    expect(
      planPrimeAgentRestartReplay({
        ...input,
        compactionHistory: history,
        authorityFingerprints: input.authorityFingerprints.toReversed(),
      }),
    ).toEqual({ valid: false });
  });

  it("reconstructs consecutive compactions without treating the old summary as a retained message", () => {
    const second = entry("e", "d", {
      type: "compaction",
      firstKeptEntryId: "d",
      summary: "second",
      tokensBefore: 700,
    });
    const history = decode(tree([first, retained, compact, post, second], "e"), "e");
    expect(history?.previous).toEqual(requireHistory().current);
    expect(history?.retainedCount).toBe(1);
    expect(history?.current).toHaveLength(2);
  });
});
