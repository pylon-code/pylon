// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import {
  decodeJcodeResumeCursor,
  encodeJcodeResumeCursor,
  isJcodeResumeCursor,
  JCODE_RESUME_CURSOR,
} from "./JcodeResumeCursor.ts";

describe("JcodeResumeCursor", () => {
  it("exposes one constant opaque marker that carries no native identity", () => {
    expect(JCODE_RESUME_CURSOR).toEqual({
      schemaVersion: 1,
      kind: "jcode-private-session",
      continue: true,
    });
    expect(Object.keys(JCODE_RESUME_CURSOR).toSorted()).toEqual([
      "continue",
      "kind",
      "schemaVersion",
    ]);
    expect(encodeJcodeResumeCursor()).toEqual(JCODE_RESUME_CURSOR);

    const serialized = JSON.stringify(JCODE_RESUME_CURSOR);
    for (const leak of ["sessionId", "socket", "home", "path", "token", "credential", "/"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("accepts only the exact marker", () => {
    expect(isJcodeResumeCursor(JCODE_RESUME_CURSOR)).toBe(true);
    expect(decodeJcodeResumeCursor(JCODE_RESUME_CURSOR)).toEqual(JCODE_RESUME_CURSOR);
    expect(
      decodeJcodeResumeCursor({
        schemaVersion: 1,
        kind: "jcode-private-session",
        continue: true,
      }),
    ).toEqual(JCODE_RESUME_CURSOR);
    expect(decodeJcodeResumeCursor(JSON.parse(JSON.stringify(JCODE_RESUME_CURSOR)))).toEqual(
      JCODE_RESUME_CURSOR,
    );
  });

  it("fails closed on malformed, foreign, and future payloads", () => {
    for (const cursor of [
      undefined,
      null,
      "",
      "jcode-private-session",
      0,
      1,
      true,
      [],
      [JCODE_RESUME_CURSOR],
      {},
      { schemaVersion: 1, kind: "jcode-private-session" },
      { schemaVersion: 1, continue: true },
      { kind: "jcode-private-session", continue: true },
      { schemaVersion: 0, kind: "jcode-private-session", continue: true },
      { schemaVersion: 2, kind: "jcode-private-session", continue: true },
      { schemaVersion: "1", kind: "jcode-private-session", continue: true },
      { schemaVersion: 1, kind: "jcode-private-sessions", continue: true },
      { schemaVersion: 1, kind: "prime-agent-daemon-session", continue: true },
      { schemaVersion: 1, kind: "jcode-private-session", continue: false },
      { schemaVersion: 1, kind: "jcode-private-session", continue: "true" },
    ]) {
      expect(isJcodeResumeCursor(cursor)).toBe(false);
      expect(decodeJcodeResumeCursor(cursor)).toBe(undefined);
    }
  });

  it("rejects any cursor that smuggles native identity alongside the marker", () => {
    for (const extra of [
      { sessionId: "native-session-secret" },
      { activeSessionId: "native-session-secret" },
      { nativeSessionId: "native-session-secret" },
      { socketPath: "/private/var/folders/jcode/api.sock" },
      { home: "/state/provider-sessions/jcode/b64-abc/home" },
      { jcodeHome: "/state/provider-sessions/jcode/b64-abc/home" },
      { credentials: "sk-ant-secret-value-1234" },
      { apiKey: "sk-ant-secret-value-1234" },
      { events: [{ type: "assistant.delta", text: "secret" }] },
      { workingDir: "/Users/someone/project" },
      { __proto__: undefined, extra: 1 },
    ]) {
      const cursor = { ...JCODE_RESUME_CURSOR, ...extra };
      expect(isJcodeResumeCursor(cursor)).toBe(false);
      expect(decodeJcodeResumeCursor(cursor)).toBe(undefined);
    }
  });

  it("rejects malformed JSON sources without throwing", () => {
    for (const source of ["not json", "{", "[]", "null", '"jcode"', "{}"]) {
      let raw: unknown;
      try {
        raw = JSON.parse(source);
      } catch {
        raw = undefined;
      }
      expect(isJcodeResumeCursor(raw)).toBe(false);
    }
  });
});
