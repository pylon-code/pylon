import { describe, expect, it } from "vite-plus/test";
import { openCodeTranscriptDigest } from "./opencodeRollback.ts";

const transcript = (prefix: string) => [
  {
    info: { id: `${prefix}user`, sessionID: prefix, role: "user" },
    parts: [
      {
        id: `${prefix}input`,
        messageID: `${prefix}user`,
        sessionID: prefix,
        type: "text",
        text: "Build it",
      },
    ],
  },
  {
    info: {
      id: `${prefix}assistant`,
      sessionID: prefix,
      role: "assistant",
      parentID: `${prefix}user`,
    },
    parts: [
      {
        id: `${prefix}tool`,
        messageID: `${prefix}assistant`,
        sessionID: prefix,
        type: "tool",
        callID: "stable-tool-id",
        state: { status: "completed", input: { path: "file.ts" }, output: "done" },
      },
    ],
  },
];

describe("OpenCode exact transcript proof", () => {
  it("normalizes native fork identities while preserving content and relationships", () => {
    expect(openCodeTranscriptDigest(transcript("source"))).toBe(
      openCodeTranscriptDigest(transcript("fork")),
    );
    const changed = transcript("fork");
    Object.assign(changed[0]!.parts[0]!, { text: "Different prompt" });
    expect(openCodeTranscriptDigest(changed)).not.toBe(
      openCodeTranscriptDigest(transcript("source")),
    );
  });
  it("rejects a dangling or future assistant parent, and mismatched part ownership", () => {
    for (const parentID of ["missing", "sourceassistant"]) {
      const changed = transcript("source");
      changed[1]!.info.parentID = parentID;
      expect(openCodeTranscriptDigest(changed)).toBeUndefined();
    }
    const changed = transcript("source");
    changed[1]!.parts[0]!.messageID = "sourceuser";
    expect(openCodeTranscriptDigest(changed)).toBeUndefined();
  });
  it("retains tool IDs, metadata, unknown fields, and canonical object ordering", () => {
    const source = transcript("source");
    const changed = transcript("fork");
    Object.assign(changed[1]!.parts[0]!, { callID: "another-tool-id" });
    expect(openCodeTranscriptDigest(changed)).not.toBe(openCodeTranscriptDigest(source));
    expect(
      openCodeTranscriptDigest(source.map((entry) => ({ parts: entry.parts, info: entry.info }))),
    ).toBe(openCodeTranscriptDigest(source));
    expect(
      openCodeTranscriptDigest(source.map((entry) => ({ ...entry, unknownNativeState: true }))),
    ).not.toBe(openCodeTranscriptDigest(source));
  });
  it("normalizes retained compaction tails and rejects missing or future fork references", () => {
    const source = transcript("source");
    const fork = transcript("fork");
    Object.assign(source[1]!.parts[0]!, { type: "compaction", tail_start_id: "sourceuser" });
    Object.assign(fork[1]!.parts[0]!, { type: "compaction", tail_start_id: "forkuser" });
    expect(openCodeTranscriptDigest(source)).toBe(openCodeTranscriptDigest(fork));
    Object.assign(source[1]!.parts[0]!, { tail_start_id: "missing" });
    expect(openCodeTranscriptDigest(source)).toBeUndefined();
    Object.assign(fork[0]!.parts[0]!, { type: "compaction", tail_start_id: "forkassistant" });
    expect(openCodeTranscriptDigest(fork)).toBeUndefined();
  });
});
