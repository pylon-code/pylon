// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import {
  isPrimeAgentCompatibleResumeCursor,
  PRIME_AGENT_ACP_RESUME_CURSOR,
  PRIME_AGENT_DAEMON_RESUME_CURSOR,
} from "./PrimeAgentResumeCursor.ts";

describe("PrimeAgentResumeCursor", () => {
  it("accepts both opaque backend markers for the shared deterministic session directory", () => {
    expect(isPrimeAgentCompatibleResumeCursor(PRIME_AGENT_ACP_RESUME_CURSOR)).toBe(true);
    expect(isPrimeAgentCompatibleResumeCursor(PRIME_AGENT_DAEMON_RESUME_CURSOR)).toBe(true);
  });

  it("rejects malformed, native, and future cursor payloads", () => {
    expect(isPrimeAgentCompatibleResumeCursor(undefined)).toBe(false);
    expect(
      isPrimeAgentCompatibleResumeCursor({
        schemaVersion: 2,
        kind: "prime-agent-daemon-continue",
        continue: false,
      }),
    ).toBe(false);
    expect(
      isPrimeAgentCompatibleResumeCursor({
        schemaVersion: 3,
        kind: "prime-agent-daemon-continue",
        continue: true,
        activeSessionId: "native-secret",
      }),
    ).toBe(false);
  });
});
