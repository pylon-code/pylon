import { MessageId, type OrchestrationMessage, type ThreadHandoffEstimate } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadHandoffSeed,
  CONDENSED_VERBATIM_TURN_COUNT,
  selectHandoffMessages,
} from "./ThreadHandoff.logic";

let messageCounter = 0;
const message = (role: OrchestrationMessage["role"], text: string): OrchestrationMessage => {
  messageCounter += 1;
  return {
    id: MessageId.make(`msg-${messageCounter}`),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
};

const VERBATIM: ThreadHandoffEstimate = {
  fidelity: "verbatim",
  carriedTokens: 31_000,
  contextShare: 0.03,
  isEmpty: false,
};
const CONDENSED: ThreadHandoffEstimate = {
  fidelity: "condensed",
  carriedTokens: 700_000,
  contextShare: 0.7,
  isEmpty: false,
};

const conversation = (turns: number): OrchestrationMessage[] =>
  Array.from({ length: turns }, (_, index) =>
    index % 2 === 0 ? message("user", `ask ${index}`) : message("assistant", `reply ${index}`),
  );

describe("selectHandoffMessages", () => {
  // The common case: it fits, so nothing is left behind.
  it("carries every turn when the thread fits", () => {
    const messages = conversation(20);
    const selected = selectHandoffMessages({ messages, estimate: VERBATIM });

    expect(selected.carried).toHaveLength(20);
    expect(selected.omittedCount).toBe(0);
  });

  it("keeps only the most recent turns when condensing", () => {
    const messages = conversation(20);
    const selected = selectHandoffMessages({ messages, estimate: CONDENSED });

    expect(selected.carried).toHaveLength(CONDENSED_VERBATIM_TURN_COUNT);
    expect(selected.omittedCount).toBe(20 - CONDENSED_VERBATIM_TURN_COUNT);
    // The tail is where the live work is — what was just tried and asked.
    expect(selected.carried.at(-1)?.text).toBe("reply 19");
  });

  it("carries a short thread whole even when told to condense", () => {
    const messages = conversation(3);
    const selected = selectHandoffMessages({ messages, estimate: CONDENSED });

    expect(selected.carried).toHaveLength(3);
    expect(selected.omittedCount).toBe(0);
  });

  it("drops blank messages rather than carrying empty turns", () => {
    const messages = [message("user", "real"), message("assistant", "   ")];
    const selected = selectHandoffMessages({ messages, estimate: VERBATIM });

    expect(selected.carried).toHaveLength(1);
  });
});

describe("buildThreadHandoffSeed", () => {
  const seedFor = (messages: OrchestrationMessage[], estimate = VERBATIM, diffSummary?: string) =>
    buildThreadHandoffSeed({
      messages,
      estimate,
      sourceAccountName: "Claude Work",
      targetAccountName: "Claude Personal",
      ...(diffSummary ? { diffSummary } : {}),
    });

  // A continuation that writes as if it remembers earlier work is the failure
  // mode this whole message exists to prevent.
  it("tells the continuation it has no memory of the earlier thread", () => {
    const seed = seedFor([message("user", "add retries to the client")]);

    expect(seed).toContain("no memory");
    expect(seed).toContain("Claude Work");
    expect(seed).toContain("Claude Personal");
  });

  it("carries the original request under its own heading", () => {
    const seed = seedFor([
      message("user", "add retries to the client"),
      message("assistant", "done"),
    ]);

    expect(seed).toContain("## Original request");
    expect(seed).toContain("add retries to the client");
  });

  it("includes the diff and points the continuation at it over the prose", () => {
    const seed = seedFor(
      [message("user", "add retries"), message("assistant", "edited 3 files")],
      VERBATIM,
      "3 files changed, 40 insertions(+), 2 deletions(-)",
    );

    expect(seed).toContain("## Changes already made");
    expect(seed).toContain("3 files changed");
    expect(seed).toContain("the diff is the record of what changed");
  });

  // Without a diff there is nothing to anchor on, so the instruction has to
  // change rather than promise a record that is not there.
  it("still tells it to verify when no diff is available", () => {
    const seed = seedFor([message("user", "add retries")]);

    expect(seed).toContain("Check the current state of the repository");
    expect(seed).not.toContain("the diff is the record");
  });

  it("says how many turns were left out when condensing", () => {
    const seed = seedFor(conversation(20), CONDENSED, "3 files changed");

    expect(seed).toContain(`${20 - CONDENSED_VERBATIM_TURN_COUNT} earlier turns`);
    expect(seed).toContain("## Most recent turns");
  });

  it("does not claim turns were omitted when carrying everything", () => {
    const seed = seedFor(conversation(4));

    expect(seed).toContain("## What happened so far");
    expect(seed).not.toContain("earlier turns");
  });

  // An empty thread should start fresh rather than open with a handoff that
  // transfers nothing.
  it.each([
    ["no messages", []],
    ["only blank messages", [message("user", "  ")]],
  ])("returns null for %s", (_label, messages) => {
    expect(seedFor(messages as OrchestrationMessage[])).toBeNull();
  });

  it("reads without account names when they are unknown", () => {
    const seed = buildThreadHandoffSeed({
      messages: [message("user", "add retries")],
      estimate: VERBATIM,
    });

    expect(seed).toContain("fresh session");
    expect(seed).not.toContain("undefined");
  });
});
