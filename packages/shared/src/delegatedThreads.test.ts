import * as NodeCrypto from "node:crypto";

import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PAIR_DELEGATION_KEY,
  delegatedParentThreadId,
  isPairExecutorThreadId,
  pairExecutorThreadId,
} from "./delegatedThreads.ts";

/** The server's formula: `delegated:<lead>:<first 16 hex of sha256(lead + "\n" + key)>`. */
const serverChildId = (lead: string, key: string) =>
  `delegated:${lead}:${NodeCrypto.createHash("sha256").update(`${lead}\n${key}`).digest("hex").slice(0, 16)}`;

describe("pair executor identity", () => {
  it("matches the id the server derives for the reserved key", () => {
    expect(PAIR_DELEGATION_KEY).toBe("pair");
    for (const lead of ["thread-lead", "import:codex:with:colons", "45276097-e1a4-4be1-9d1b"]) {
      expect(pairExecutorThreadId(ThreadId.make(lead))).toBe(serverChildId(lead, "pair"));
    }
  });

  it("resolves back to its lead", () => {
    const lead = ThreadId.make("import:a:b");
    expect(delegatedParentThreadId(pairExecutorThreadId(lead))).toBe(lead);
  });

  it("tells an executor from a fan-out child and from an ordinary thread", () => {
    const lead = ThreadId.make("thread-lead");
    expect(isPairExecutorThreadId(pairExecutorThreadId(lead))).toBe(true);
    expect(isPairExecutorThreadId(ThreadId.make(serverChildId(lead, "review-auth")))).toBe(false);
    expect(isPairExecutorThreadId(lead)).toBe(false);
    expect(isPairExecutorThreadId(ThreadId.make("delegated:broken"))).toBe(false);
  });
});
