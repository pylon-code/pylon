// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import { decodePrimeAgentDaemonEvent, type PrimeDaemonMessage } from "./PrimeAgentDaemonEvents.ts";
import { planPrimeAgentRestartReplay } from "./PrimeAgentDaemonAdapter.ts";

const message = (index: number): PrimeDaemonMessage => ({
  role: "user",
  timestamp: index,
  text: `message-${index}`,
  imageMimeTypes: [],
  imageDigests: [],
});
const fingerprint = (value: PrimeDaemonMessage) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

describe("planPrimeAgentRestartReplay", () => {
  it("replays only the exact suffix after proving the overlap", () => {
    const messages = [1, 2, 3, 4, 5].map(message);
    const replay = planPrimeAgentRestartReplay({
      authorityMessageCount: 3,
      authorityFingerprints: messages.slice(0, 3).map(fingerprint),
      snapshotMessageCount: 5,
      snapshotMessages: messages,
    });
    expect(replay).toEqual({ valid: true, backlog: messages.slice(3) });
  });

  it("resumes paired refinement messages without accepting changed or reordered history", () => {
    const refinements = ["refinement_outcome", "refinement_notice"].map((customType, index) => {
      const decoded = decodePrimeAgentDaemonEvent(
        {
          type: "session_event",
          attribution: { scope: "session" },
          event: {
            type: "message_end",
            promptCorrelationId: null,
            message: {
              role: "custom",
              customType,
              display: index === 0,
              timestamp: index,
              content: "private memory",
              details: { refinementId: "fixture", source: "auto" },
            },
          },
        },
        { correlatedPromptLifecycle: true },
      );
      if (decoded._tag !== "MessageCompleted") throw new Error("missing refinement");
      return decoded.message;
    });
    const snapshotMessages = [...refinements, message(3)];
    const authority = {
      authorityMessageCount: 2,
      authorityFingerprints: refinements.map(fingerprint),
    };
    expect(
      planPrimeAgentRestartReplay({ ...authority, snapshotMessageCount: 3, snapshotMessages }),
    ).toEqual({ valid: true, backlog: [message(3)] });
    for (const history of [
      refinements.toReversed(),
      refinements.map((item) => ({ ...item, timestamp: 99 })),
      refinements.slice(0, 1),
    ]) {
      expect(
        planPrimeAgentRestartReplay({
          ...authority,
          snapshotMessageCount: 3,
          snapshotMessages: [...history, message(3)],
        }),
      ).toEqual({ valid: false });
    }
  });

  it("resumes built-in private messages without accepting changed or reordered history", () => {
    const refinements = [
      "compaction_outcome",
      "ipython_state_restored",
      "session_slash_command",
      "session_slash_command_result",
      "rlm_child_failure",
      "rlm_child_terminal_notice",
      "async_bash_completion",
      "agent_message",
    ].map((customType, index) => {
      const decoded = decodePrimeAgentDaemonEvent(
        {
          type: "session_event",
          attribution: { scope: "session" },
          event: {
            type: "message_end",
            promptCorrelationId: null,
            message: {
              role: "custom",
              customType,
              display: index === 0,
              timestamp: index,
              content: "private memory",
              details: { refinementId: "fixture", source: "auto" },
            },
          },
        },
        { correlatedPromptLifecycle: true },
      );
      if (decoded._tag !== "MessageCompleted") throw new Error("missing refinement");
      return decoded.message;
    });
    const snapshotMessages = [...refinements, message(20)];
    const authority = {
      authorityMessageCount: refinements.length,
      authorityFingerprints: refinements.map(fingerprint),
    };
    expect(
      planPrimeAgentRestartReplay({
        ...authority,
        snapshotMessageCount: refinements.length + 1,
        snapshotMessages,
      }),
    ).toEqual({ valid: true, backlog: [message(20)] });
    for (const history of [
      refinements.toReversed(),
      refinements.map((item) => ({ ...item, timestamp: 99 })),
      refinements.slice(0, 1),
    ]) {
      expect(
        planPrimeAgentRestartReplay({
          ...authority,
          snapshotMessageCount: refinements.length + 1,
          snapshotMessages: [...history, message(20)],
        }),
      ).toEqual({ valid: false });
    }
  });

  it("fails closed on changed overlap or a transcript retention gap", () => {
    const messages = [1, 2, 3, 4, 5].map(message);
    expect(
      planPrimeAgentRestartReplay({
        authorityMessageCount: 3,
        authorityFingerprints: [messages[0]!, messages[1]!, message(30)].map(fingerprint),
        snapshotMessageCount: 5,
        snapshotMessages: messages,
      }),
    ).toEqual({ valid: false });

    const longTranscript = Array.from({ length: 1_026 }, (_, index) => message(index));
    expect(
      planPrimeAgentRestartReplay({
        authorityMessageCount: 1,
        authorityFingerprints: [fingerprint(longTranscript[0]!)],
        snapshotMessageCount: longTranscript.length,
        snapshotMessages: longTranscript.slice(-1_024),
      }),
    ).toEqual({ valid: false });
  });
});
