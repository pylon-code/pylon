// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to contract tests.
import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS,
  PROVIDER_SESSION_AGENT_ACTIVITY_MAX_ENTRIES,
  ProviderSessionAgentActivitySnapshot,
  ProviderWatchSessionAgentActivityError,
} from "./provider.ts";

const decodeSnapshot = Schema.decodeUnknownSync(ProviderSessionAgentActivitySnapshot);
const decodeWatchError = Schema.decodeUnknownSync(ProviderWatchSessionAgentActivityError);

describe("ProviderSessionAgentActivitySnapshot", () => {
  it("accepts an empty replacement snapshot and trims non-empty assistant text", () => {
    expect(decodeSnapshot({ agentId: "agent-1", revision: 1, entries: [] })).toEqual({
      agentId: "agent-1",
      revision: 1,
      entries: [],
    });
    expect(
      decodeSnapshot({
        agentId: "agent-1",
        revision: 2,
        entries: [{ speaker: "assistant", text: "  visible  " }],
      }).entries,
    ).toEqual([{ speaker: "assistant", text: "visible" }]);
  });

  it("rejects empty text, non-assistant speakers, and excessive entries", () => {
    expect(() =>
      decodeSnapshot({
        agentId: "agent-1",
        revision: 1,
        entries: [{ speaker: "assistant", text: "   " }],
      }),
    ).toThrow();
    expect(() =>
      decodeSnapshot({
        agentId: "agent-1",
        revision: 1,
        entries: [{ speaker: "user", text: "private prompt" }],
      }),
    ).toThrow();
    expect(() =>
      decodeSnapshot({
        agentId: "agent-1",
        revision: 1,
        entries: Array.from({ length: PROVIDER_SESSION_AGENT_ACTIVITY_MAX_ENTRIES + 1 }, () => ({
          speaker: "assistant",
          text: "x",
        })),
      }),
    ).toThrow();
  });

  it("counts Unicode code points without splitting astral characters", () => {
    const emoji = "😀";
    expect(
      decodeSnapshot({
        agentId: "agent-1",
        revision: 1,
        entries: [
          {
            speaker: "assistant",
            text: emoji.repeat(PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS),
          },
        ],
      }).entries[0]?.text,
    ).toBe(emoji.repeat(PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS));
    expect(() =>
      decodeSnapshot({
        agentId: "agent-1",
        revision: 1,
        entries: [
          {
            speaker: "assistant",
            text: emoji.repeat(PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS + 1),
          },
        ],
      }),
    ).toThrow();
  });

  it("enforces the full encoded snapshot byte cap including envelopes", () => {
    const emoji = "😀";
    expect(() =>
      decodeSnapshot({
        agentId: "agent-1",
        revision: 1,
        entries: Array.from({ length: 4 }, () => ({
          speaker: "assistant",
          text: emoji.repeat(PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS),
        })),
      }),
    ).toThrow();
  });

  it("drops forbidden native fields rather than admitting them to the decoded shape", () => {
    const decoded = decodeSnapshot({
      agentId: "agent-1",
      revision: 1,
      entries: [
        {
          speaker: "assistant",
          text: "safe",
          providerRefs: { activeSessionId: "secret" },
          toolCalls: [{ arguments: { secret: true } }],
          timestamp: 123,
        },
      ],
      nativeId: "secret",
      cwd: "/private/path",
    });
    expect(decoded).toEqual({
      agentId: "agent-1",
      revision: 1,
      entries: [{ speaker: "assistant", text: "safe" }],
    });
  });
});

describe("ProviderWatchSessionAgentActivityError", () => {
  it("has only the narrow public reason vocabulary", () => {
    expect(new ProviderWatchSessionAgentActivityError({ reason: "limit-reached" }).reason).toBe(
      "limit-reached",
    );
    expect(() =>
      decodeWatchError({
        _tag: "ProviderWatchSessionAgentActivityError",
        reason: "native-session-missing",
      }),
    ).toThrow();
  });
});
