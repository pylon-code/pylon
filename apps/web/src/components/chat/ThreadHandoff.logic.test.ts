import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationMessage,
  type ServerProvider,
  type ThreadHandoffEstimate,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  buildThreadHandoffSeed,
  CONDENSED_VERBATIM_TURN_COUNT,
  getThreadContinuationLinks,
  getThreadHandoffOffer,
  HANDOFF_DIFF_FILE_LIMIT,
  selectHandoffMessages,
  summarizeHandoffDiff,
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

describe("summarizeHandoffDiff", () => {
  const patchFor = (path: string, added: number, removed: number): string =>
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${removed + 1} +1,${added + 1} @@`,
      " context",
      ...Array.from({ length: removed }, (_, index) => `-gone ${index}`),
      ...Array.from({ length: added }, (_, index) => `+new ${index}`),
    ].join("\n");

  it("counts the files and lines the way git reports them", () => {
    const summary = summarizeHandoffDiff(
      [patchFor("src/a.ts", 30, 1), patchFor("src/b.ts", 10, 1)].join("\n"),
    );

    expect(summary).toContain("2 files changed, 40 insertions(+), 2 deletions(-)");
  });

  // The paths are the point: they tell the continuation where the work is.
  it("lists each file with its own line counts", () => {
    const summary = summarizeHandoffDiff(patchFor("src/a.ts", 30, 1));

    expect(summary).toContain("- src/a.ts (+30, -1)");
  });

  it("says how many files it stopped listing rather than truncating quietly", () => {
    const overflow = 3;
    const summary = summarizeHandoffDiff(
      Array.from({ length: HANDOFF_DIFF_FILE_LIMIT + overflow }, (_, index) =>
        patchFor(`src/file-${index}.ts`, 1, 0),
      ).join("\n"),
    );

    expect(summary).toContain(`and ${overflow} further files`);
    expect(summary).not.toContain(`src/file-${HANDOFF_DIFF_FILE_LIMIT}.ts (`);
  });

  // The seed changes its closing instruction when there is no diff, so an
  // unusable patch has to read as absent rather than as an empty change set.
  it.each([
    ["nothing", undefined],
    ["an empty patch", ""],
    ["unparseable text", "not a patch at all"],
  ])("returns undefined for %s", (_label, patch) => {
    expect(summarizeHandoffDiff(patch)).toBeUndefined();
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

describe("getThreadContinuationLinks", () => {
  const CLAUDE = ProviderDriverKind.make("claudeAgent");
  const shell = (input: {
    id: string;
    title: string;
    instanceId: string;
    continuedFromThreadId?: string;
  }) => ({
    id: input.id,
    environmentId: "env-1",
    title: input.title,
    modelSelection: { instanceId: input.instanceId },
    ...(input.continuedFromThreadId ? { continuedFromThreadId: input.continuedFromThreadId } : {}),
  });

  const PARENT = shell({ id: "thread-work", title: "Add retries", instanceId: "claude_work" });
  const CHILD = shell({
    id: "thread-personal",
    title: "Add retries",
    instanceId: "claude_personal",
    continuedFromThreadId: "thread-work",
  });

  const entries = deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("claude_personal"),
      driver: CLAUDE,
      displayName: "Claude Personal",
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-08-05T17:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    } as ServerProvider,
  ]);

  const linksFor = (thread: { id: string; continuedFromThreadId?: string | null }) =>
    getThreadContinuationLinks({ thread, shells: [PARENT, CHILD], entries });

  it("points a continuation back at the thread it came from", () => {
    const links = linksFor({ id: "thread-personal", continuedFromThreadId: "thread-work" });

    expect(links).toHaveLength(1);
    expect(links[0]?.direction).toBe("from");
    expect(links[0]?.threadId).toBe("thread-work");
  });

  // Without this the handed-off thread just looks abandoned.
  it("points a handed-off thread forward at where its work went", () => {
    const links = linksFor({ id: "thread-work" });

    expect(links).toHaveLength(1);
    expect(links[0]?.direction).toBe("into");
    expect(links[0]?.accountName).toBe("Claude Personal");
  });

  it("leaves an ordinary thread unmarked", () => {
    expect(linksFor({ id: "thread-unrelated" })).toEqual([]);
  });

  // A deleted parent must not leave a link that goes nowhere.
  it("drops a link whose thread is gone", () => {
    const links = getThreadContinuationLinks({
      thread: { id: "thread-personal", continuedFromThreadId: "thread-deleted" },
      shells: [CHILD],
      entries,
    });

    expect(links).toEqual([]);
  });
});

describe("getThreadHandoffOffer", () => {
  const CLAUDE = ProviderDriverKind.make("claudeAgent");
  const NOW_MS = Date.parse("2026-08-05T18:00:00.000Z");

  const account = (input: {
    instanceId: string;
    displayName: string;
    drainedUntil?: string;
    enabled?: boolean;
  }): ServerProvider => ({
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: CLAUDE,
    displayName: input.displayName,
    ...(input.drainedUntil
      ? {
          rateLimit: {
            status: "rejected" as const,
            rateLimitType: "five_hour",
            observedAt: "2026-08-05T17:00:00.000Z",
            resetsAt: input.drainedUntil,
          },
        }
      : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt: "2026-08-05T17:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  });

  const offerFor = (
    providers: ReadonlyArray<ServerProvider>,
    overrides: { usedTokens?: number; maxTokens?: number; messages?: OrchestrationMessage[] } = {},
  ) =>
    getThreadHandoffOffer({
      entries: deriveProviderInstanceEntries(providers),
      boundInstanceId: "claude_work",
      messages: overrides.messages ?? conversation(4),
      usedTokens: overrides.usedTokens ?? 31_000,
      maxTokens: overrides.maxTokens ?? 1_000_000,
      nowMs: NOW_MS,
    });

  const DRAINED_WORK = () =>
    account({
      instanceId: "claude_work",
      displayName: "Claude Work",
      drainedUntil: "2026-08-05T21:00:00.000Z",
    });
  const HEALTHY_PERSONAL = () =>
    account({ instanceId: "claude_personal", displayName: "Claude Personal" });

  it("offers the healthy account with its cost when the bound one is spent", () => {
    const offer = offerFor([DRAINED_WORK(), HEALTHY_PERSONAL()]);

    expect(offer?.spentAccountName).toBe("Claude Work");
    expect(offer?.targetAccountName).toBe("Claude Personal");
    expect(offer?.costLabel).toBe("31k");
    expect(offer?.resetsAt).toBe("2026-08-05T21:00:00.000Z");
  });

  it("says the transcript crosses whole when it fits", () => {
    const offer = offerFor([DRAINED_WORK(), HEALTHY_PERSONAL()]);

    expect(offer?.carries).toContain("all 4 turns, verbatim");
    expect(offer?.estimate.fidelity).toBe("verbatim");
  });

  it("says what gets left behind when the thread is too large", () => {
    const offer = offerFor([DRAINED_WORK(), HEALTHY_PERSONAL()], {
      usedTokens: 900_000,
      maxTokens: 1_000_000,
      messages: conversation(20),
    });

    expect(offer?.estimate.fidelity).toBe("condensed");
    expect(offer?.carries.some((line) => line.includes("left behind"))).toBe(true);
  });

  // Every case below would put a control on screen that cannot help.
  it("stays silent while the bound account is healthy", () => {
    expect(
      offerFor([
        account({ instanceId: "claude_work", displayName: "Claude Work" }),
        HEALTHY_PERSONAL(),
      ]),
    ).toBeNull();
  });

  it("stays silent when there is nowhere to hand off to", () => {
    expect(offerFor([DRAINED_WORK()])).toBeNull();
  });

  it("stays silent when the only other account is also spent", () => {
    expect(
      offerFor([
        DRAINED_WORK(),
        account({
          instanceId: "claude_personal",
          displayName: "Claude Personal",
          drainedUntil: "2026-08-05T22:00:00.000Z",
        }),
      ]),
    ).toBeNull();
  });

  it("stays silent when the other account is disabled", () => {
    expect(
      offerFor([
        DRAINED_WORK(),
        account({ instanceId: "claude_personal", displayName: "Claude Personal", enabled: false }),
      ]),
    ).toBeNull();
  });

  it("stays silent when the thread has nothing worth carrying", () => {
    expect(offerFor([DRAINED_WORK(), HEALTHY_PERSONAL()], { usedTokens: 0 })).toBeNull();
  });
});
