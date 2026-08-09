// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import {
  decodePrimeAgentSessionIdentity,
  encodePrimeAgentSessionIdentity,
  primeAgentLegacySessionFileNames,
  primeAgentSessionFileName,
} from "./PrimeAgentSessionIdentity.ts";

describe("PrimeAgentSessionIdentity", () => {
  it("round trips a stable id and direct private session file", () => {
    const source = encodePrimeAgentSessionIdentity(
      "/state/thread",
      "019fe511-5776-71ae-b907-9a33f0cd9a8d",
      "/state/thread/session-1.jsonl",
    );
    expect(source).toBe(
      '{"schemaVersion":1,"sessionId":"019fe511-5776-71ae-b907-9a33f0cd9a8d","sessionFileName":"session-1.jsonl"}\n',
    );
    expect(decodePrimeAgentSessionIdentity("/state/thread", source!)).toEqual({
      sessionId: "019fe511-5776-71ae-b907-9a33f0cd9a8d",
      sessionPath: "/state/thread/session-1.jsonl",
    });
    expect(primeAgentSessionFileName("/state/thread", "/state/thread/session-1.jsonl")).toBe(
      "session-1.jsonl",
    );
  });

  it("rejects native identities that can escape or select a host path", () => {
    expect(
      encodePrimeAgentSessionIdentity("/state/thread", "session-1", "/state/other/session.jsonl"),
    ).toBe(undefined);
    expect(
      encodePrimeAgentSessionIdentity("/state/thread", "session-1", "/state/thread/nested/a.jsonl"),
    ).toBe(undefined);
    for (const source of [
      "not json",
      '{"schemaVersion":2,"sessionId":"session-1","sessionFileName":"session.jsonl"}',
      '{"schemaVersion":1,"sessionId":"../secret","sessionFileName":"session.jsonl"}',
      '{"schemaVersion":1,"sessionId":"session-1","sessionFileName":"../secret.jsonl"}',
      '{"schemaVersion":1,"sessionId":"session-1","sessionFileName":"metadata.json"}',
    ]) {
      expect(decodePrimeAgentSessionIdentity("/state/thread", source)).toBe(undefined);
    }
  });

  it("recognizes legacy session directories without treating metadata as a session", () => {
    expect(
      primeAgentLegacySessionFileNames([
        "second.jsonl",
        ".pylon-prime-session.json",
        "first.jsonl",
      ]),
    ).toEqual(["first.jsonl", "second.jsonl"]);
    expect(primeAgentLegacySessionFileNames([".pylon-prime-session.json", "nested"])).toEqual([]);
  });
});
