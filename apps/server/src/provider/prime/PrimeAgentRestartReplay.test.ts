// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import type { PrimeDaemonMessage } from "./PrimeAgentDaemonEvents.ts";
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
