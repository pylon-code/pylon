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
const decodeLegacySnapshot = Schema.decodeUnknownSync(
  Schema.Struct({
    agentId: Schema.String,
    revision: Schema.Number,
    entries: Schema.Array(
      Schema.Struct({ speaker: Schema.Literal("assistant"), text: Schema.String }),
    ),
  }),
);

describe("ProviderSessionAgentActivitySnapshot", () => {
  it("keeps assistant entries backward compatible while adding a safe timeline", () => {
    expect(decodeSnapshot({ agentId: "agent-1", revision: 1, entries: [] })).toEqual({
      agentId: "agent-1",
      revision: 1,
      entries: [],
    });
    const wire = {
      agentId: "agent-1",
      revision: 2,
      entries: [{ speaker: "assistant", text: "  visible  " }],
      activity: [
        { speaker: "assistant", text: "  visible  " },
        { kind: "tool", activityId: 1, label: "Code", status: "started" },
        { kind: "tool", activityId: 2, label: "Shell", status: "completed" },
        { kind: "tool", activityId: 3, label: "Edit", status: "failed" },
      ],
    };
    expect(decodeSnapshot(wire)).toEqual({
      agentId: "agent-1",
      revision: 2,
      entries: [{ speaker: "assistant", text: "visible" }],
      activity: [
        { speaker: "assistant", text: "visible" },
        { kind: "tool", activityId: 1, label: "Code", status: "started" },
        { kind: "tool", activityId: 2, label: "Shell", status: "completed" },
        { kind: "tool", activityId: 3, label: "Edit", status: "failed" },
      ],
    });
    expect(decodeLegacySnapshot(wire)).toEqual({
      agentId: "agent-1",
      revision: 2,
      entries: [{ speaker: "assistant", text: "  visible  " }],
    });
  });

  it("rejects empty text, unsafe tool shapes, inconsistent mirrors, and excessive entries", () => {
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
    for (const activity of [
      [{ kind: "tool", activityId: 1, label: "Code", status: "running" }],
      [{ kind: "tool", activityId: 1, label: "   ", status: "started" }],
      [
        { kind: "tool", activityId: 1, label: "Code", status: "started" },
        { kind: "tool", activityId: 1, label: "Shell", status: "completed" },
      ],
    ]) {
      expect(() =>
        decodeSnapshot({ agentId: "agent-1", revision: 1, entries: [], activity }),
      ).toThrow();
    }
    expect(() =>
      decodeSnapshot({
        agentId: "agent-1",
        revision: 1,
        entries: [{ speaker: "assistant", text: "safe" }],
        activity: [{ speaker: "assistant", text: "different" }],
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
      }).entries[0],
    ).toEqual({
      speaker: "assistant",
      text: emoji.repeat(PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS),
    });
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
    const mirroredAssistant = Array.from({ length: 2 }, () => ({
      speaker: "assistant" as const,
      text: emoji.repeat(PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS),
    }));
    expect(() =>
      decodeSnapshot({
        agentId: "agent-1",
        revision: 1,
        entries: mirroredAssistant,
        activity: [
          ...mirroredAssistant,
          { kind: "tool", activityId: 1, label: "Code", status: "started" },
        ],
      }),
    ).toThrow();
  });

  it("drops forbidden native fields rather than admitting them to either projection", () => {
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
      activity: [
        { speaker: "assistant", text: "safe" },
        {
          kind: "tool",
          activityId: 1,
          label: "Code",
          status: "failed",
          nativeToolId: "secret-tool-id",
          args: { path: "/private" },
          result: "private output",
          error: "private error",
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
      activity: [
        { speaker: "assistant", text: "safe" },
        { kind: "tool", activityId: 1, label: "Code", status: "failed" },
      ],
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
