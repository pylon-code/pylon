// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import {
  isPrimeAgentCompatibleResumeCursor,
  PRIME_AGENT_ACP_RESUME_CURSOR,
  PRIME_AGENT_DAEMON_RESUME_CURSOR,
} from "./PrimeAgentResumeCursor.ts";

describe("PrimeAgentResumeCursor", () => {
  it("accepts opaque current and migration markers without native identity", () => {
    expect(PRIME_AGENT_DAEMON_RESUME_CURSOR).toEqual({
      schemaVersion: 3,
      kind: "prime-agent-daemon-session",
      continue: true,
    });
    expect(isPrimeAgentCompatibleResumeCursor(PRIME_AGENT_ACP_RESUME_CURSOR)).toBe(true);
    expect(isPrimeAgentCompatibleResumeCursor(PRIME_AGENT_DAEMON_RESUME_CURSOR)).toBe(true);
    expect(
      isPrimeAgentCompatibleResumeCursor({
        schemaVersion: 2,
        kind: "prime-agent-daemon-continue",
        continue: true,
      }),
    ).toBe(true);
  });

  it("rejects malformed, native, and future cursor payloads", () => {
    for (const cursor of [
      undefined,
      {
        schemaVersion: 2,
        kind: "prime-agent-daemon-continue",
        continue: false,
      },
      {
        ...PRIME_AGENT_DAEMON_RESUME_CURSOR,
        activeSessionId: "native-secret",
      },
      {
        ...PRIME_AGENT_DAEMON_RESUME_CURSOR,
        sessionId: "native-secret",
      },
      {
        schemaVersion: 4,
        kind: "prime-agent-daemon-session",
        continue: true,
      },
    ]) {
      expect(isPrimeAgentCompatibleResumeCursor(cursor)).toBe(false);
    }
  });
});
