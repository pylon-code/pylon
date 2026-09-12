import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ServerProvider,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveComposerInstanceSelection } from "../composerInstanceSelection";
import { deriveProviderInstanceEntries } from "../providerInstances";

import type { Thread, ThreadShell, TurnDiffSummary } from "../types";
import type { CodexArtifactTemplate } from "@t3tools/client-runtime/codex-artifact-templates";
import {
  type RightPanelSurface,
  pullRequestSurface,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  agentControlledBrowserCloseConfirmation,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLoadingThreadFromShell,
  buildRunningThreadTurnInterruptInput,
  buildThreadTurnInterruptInput,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  deriveLockedProvider,
  dismissBranchMismatchForSession,
  ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  getStartedThreadModelChangeBlockReason,
  mergeFailedComposerSend,
  hasEnvironmentReconnectWarningGraceElapsed,
  hasServerAcknowledgedLocalDispatch,
  shouldRefocusComposerOnWindowFocus,
  isBranchMismatchDismissedForSession,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
  resolveBackgroundDraftWorkspaceOptions,
  resolveDraftPromotionNavigationTarget,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  threadShellHasStarted,
  resolveDraftHeroState,
  isPaintOnlyThreadTimeline,
  peekHeldThreadTimeline,
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resetHeldThreadTimeline,
  resolveThreadSwitchTimeline,
  threadKeysShareEnvironment,
  timelineHasEphemeralPreviewUrls,
  scheduleEnvironmentReconnectWarning,
  startNewThreadForProject,
  codexArtifactTemplatePromptToAppend,
  shouldDockDraftHeroForSubmission,
  shouldReleaseTimelineAnchorForToolActivity,
  shouldRetargetThreadPullRequestPanel,
  shouldShowBranchMismatchBanner,
  shouldOpenProactivePullRequest,
  shouldOpenProactiveTurnDiff,
  shouldRenderPreviewMiniPlayer,
  resolveProactiveTurnDiffAction,
  observeProactivePanelUserChoice,
  shouldShowPlanFollowUpPrompt,
  shouldWriteThreadErrorToCurrentServerThread,
  toolGroupConsumesUpwardNavigation,
  getAntigravitySendBlockReason,
} from "./ChatView.logic";

describe("agent browser close confirmation", () => {
  const surfaces = [
    { id: "browser:one", kind: "preview", resourceId: "tab-1" },
    { id: "browser:two", kind: "preview", resourceId: "tab-2" },
    { id: "diff", kind: "diff" },
  ] satisfies RightPanelSurface[];

  it("only warns for browsers under active agent control", () => {
    expect(
      agentControlledBrowserCloseConfirmation(surfaces, {
        "tab-1": { controller: "none" },
        "tab-2": { controller: "human" },
      }),
    ).toBeNull();

    expect(
      agentControlledBrowserCloseConfirmation([surfaces[0]!], {
        "tab-1": { controller: "agent" },
      }),
    ).toBe(
      [
        "Close browser while the agent is using it?",
        "The agent is actively controlling this browser. Closing it may interrupt the current browser action.",
      ].join("\n"),
    );
  });

  it("counts every agent-controlled browser in a bulk close", () => {
    expect(
      agentControlledBrowserCloseConfirmation(surfaces, {
        "tab-1": { controller: "agent" },
        "tab-2": { controller: "agent" },
      }),
    ).toContain("Close 2 browsers");
  });
});

describe("proactive panels", () => {
  it("keeps a manual PR selection made after following a replacement while loading", () => {
    useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
    const ref = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
    const panels = useRightPanelStore.getState();
    const oldPr = pullRequestSurface({
      projectId: "project-1",
      repository: "owner/repo",
      number: 1,
    });
    const replacement = pullRequestSurface({ ...oldPr, number: 2 });
    const turnId = TurnId.make("turn-1");
    panels.openPullRequest(ref, oldPr);
    const loading = observeProactivePanelUserChoice(null, {
      threadKey: "env-1:thread-1",
      runningTurnId: turnId,
      userActionRevision: panels.getUserActionRevision(ref),
    });
    expect(panels.openProactive(ref, replacement, loading.userActionRevision)).toBe(true);

    panels.activateSurface(ref, oldPr.id);
    const loaded = observeProactivePanelUserChoice(loading, {
      threadKey: loading.threadKey,
      runningTurnId: turnId,
      userActionRevision: panels.getUserActionRevision(ref),
    });
    expect(panels.openProactive(ref, replacement, loaded.userActionRevision)).toBe(false);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)).toEqual(
      oldPr,
    );
    expect(shouldOpenProactivePullRequest(loaded.targetKey, "owner/repo:2")).toBe(true);
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: loaded.runningTurnId,
        runningTurnId: null,
        settledTurnId: turnId,
        turnCompleted: true,
      }),
    ).toBe(true);
    expect(panels.openProactive(ref, { id: "diff", kind: "diff" }, loaded.userActionRevision)).toBe(
      false,
    );
  });

  it.each(["idle", "loading", "observed"] as const)(
    "captures a new turn's choice once with initial state %s",
    (initialState) => {
      useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
      const ref = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
      const panels = useRightPanelStore.getState();
      const firstTurn = TurnId.make("turn-1");
      const nextTurn = TurnId.make("turn-2");
      const initial = observeProactivePanelUserChoice(null, {
        threadKey: "env-1:thread-1",
        runningTurnId: initialState === "idle" ? null : firstTurn,
        userActionRevision: panels.getUserActionRevision(ref),
      });
      panels.openFile(ref, "src/first.ts");
      const loadingNextTurn = observeProactivePanelUserChoice(
        {
          ...initial,
          ...(initialState === "observed" ? { runningTurnId: firstTurn, targetKey: null } : {}),
        },
        {
          threadKey: initial.threadKey,
          runningTurnId: nextTurn,
          userActionRevision: panels.getUserActionRevision(ref),
        },
      );
      expect(
        panels.openProactive(ref, { id: "diff", kind: "diff" }, loadingNextTurn.userActionRevision),
      ).toBe(true);

      panels.openFile(ref, "src/second.ts");
      const loaded = observeProactivePanelUserChoice(loadingNextTurn, {
        threadKey: initial.threadKey,
        runningTurnId: nextTurn,
        userActionRevision: panels.getUserActionRevision(ref),
      });
      expect(
        panels.openProactive(ref, { id: "diff", kind: "diff" }, loaded.userActionRevision),
      ).toBe(false);
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)?.id,
      ).toBe("file:src/second.ts");
    },
  );

  it("opens an existing pull request on entry and follows newly observed links", () => {
    expect(shouldOpenProactivePullRequest(undefined, "project:repo:42")).toBe(true);
    expect(shouldOpenProactivePullRequest(undefined, null)).toBe(false);
    expect(shouldOpenProactivePullRequest(null, "project:repo:42")).toBe(true);
    expect(shouldOpenProactivePullRequest("project:repo:42", "project:repo:42")).toBe(false);
    expect(shouldOpenProactivePullRequest("project:repo:42", null)).toBe(false);
  });

  it("opens a completed diff on entry or when the observed running turn settles", () => {
    const turnId = TurnId.make("turn-1");
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: undefined,
        runningTurnId: null,
        settledTurnId: turnId,
        turnCompleted: true,
      }),
    ).toBe(true);
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: turnId,
        runningTurnId: null,
        settledTurnId: turnId,
        turnCompleted: true,
      }),
    ).toBe(true);
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: turnId,
        runningTurnId: TurnId.make("turn-2"),
        settledTurnId: turnId,
        turnCompleted: true,
      }),
    ).toBe(false);
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: turnId,
        runningTurnId: null,
        settledTurnId: turnId,
        turnCompleted: false,
      }),
    ).toBe(false);
  });

  it("opens a completed turn diff only for changed files", () => {
    const changedCheckpoint = {
      status: "ready",
      files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
    } satisfies Pick<TurnDiffSummary, "status" | "files">;
    const unchangedCheckpoint = {
      status: "ready",
      files: [],
    } satisfies Pick<TurnDiffSummary, "status" | "files">;

    expect(
      resolveProactiveTurnDiffAction({
        checkpoint: changedCheckpoint,
        isGitRepo: true,
      }),
    ).toBe("open");
    expect(
      resolveProactiveTurnDiffAction({
        checkpoint: unchangedCheckpoint,
        isGitRepo: true,
      }),
    ).toBe("ignore");
  });

  it("waits for definitive checkpoint and repository state", () => {
    const missingCheckpoint = {
      status: "missing",
      files: [],
    } satisfies Pick<TurnDiffSummary, "status" | "files">;
    const changedCheckpoint = {
      status: "ready",
      files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
    } satisfies Pick<TurnDiffSummary, "status" | "files">;

    expect(
      resolveProactiveTurnDiffAction({
        checkpoint: undefined,
        isGitRepo: true,
      }),
    ).toBe("defer");
    expect(
      resolveProactiveTurnDiffAction({
        checkpoint: missingCheckpoint,
        isGitRepo: true,
      }),
    ).toBe("defer");
    expect(
      resolveProactiveTurnDiffAction({
        checkpoint: changedCheckpoint,
        isGitRepo: undefined,
      }),
    ).toBe("defer");
  });
});

describe("toolGroupConsumesUpwardNavigation", () => {
  class ScrollElement extends EventTarget {
    scrollTop = 0;
    scrollHeight = 100;
    clientHeight = 100;
    overflowY = "visible";

    constructor(
      readonly parentElement: ScrollElement | null = null,
      readonly isToolGroup = false,
    ) {
      super();
    }

    closest(selector: string): ScrollElement | null {
      if (selector !== "[data-tool-group-scroll]") return null;
      return this.isToolGroup ? this : (this.parentElement?.closest(selector) ?? null);
    }
  }

  beforeEach(() => {
    vi.stubGlobal("Element", ScrollElement);
    vi.stubGlobal("getComputedStyle", (element: ScrollElement) => ({
      overflowY: element.overflowY,
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("releases upward navigation when an overflowing group is at the top", () => {
    const group = Object.assign(new ScrollElement(null, true), {
      overflowY: "auto",
      scrollHeight: 300,
    });

    expect(toolGroupConsumesUpwardNavigation(new ScrollElement(group))).toBe(false);
  });

  it.each([
    { overflowY: "auto", scrollTop: 1 },
    { overflowY: "auto", scrollTop: 0.25 },
    { overflowY: "scroll", scrollTop: 80 },
  ])("consumes upward navigation within a scrolled group: %j", (scroll) => {
    const group = Object.assign(new ScrollElement(null, true), {
      scrollHeight: 300,
      ...scroll,
    });

    expect(toolGroupConsumesUpwardNavigation(group)).toBe(true);
  });

  it.each([100, 300])(
    "consumes scrolling in a nested result with a group content height of %i",
    (scrollHeight) => {
      const group = Object.assign(new ScrollElement(null, true), {
        overflowY: "auto",
        scrollHeight,
      });
      const result = Object.assign(new ScrollElement(group), {
        overflowY: "auto",
        scrollHeight: 300,
        scrollTop: 0.25,
      });

      expect(toolGroupConsumesUpwardNavigation(new ScrollElement(result))).toBe(true);
    },
  );

  it("releases upward navigation when the group and nested result are both at the top", () => {
    const group = Object.assign(new ScrollElement(null, true), {
      overflowY: "auto",
      scrollHeight: 300,
    });
    const result = Object.assign(new ScrollElement(group), {
      overflowY: "scroll",
      scrollHeight: 300,
    });

    expect(toolGroupConsumesUpwardNavigation(new ScrollElement(result))).toBe(false);
  });

  it("ignores targets outside a tool group and non-element targets", () => {
    const outside = Object.assign(new ScrollElement(), {
      overflowY: "auto",
      scrollHeight: 300,
      scrollTop: 40,
    });

    expect(toolGroupConsumesUpwardNavigation(outside)).toBe(false);
    expect(toolGroupConsumesUpwardNavigation(new EventTarget())).toBe(false);
    expect(toolGroupConsumesUpwardNavigation(null)).toBe(false);
  });

  it("does not consume scrolling from an ancestor beyond the tool group", () => {
    const timeline = Object.assign(new ScrollElement(), {
      overflowY: "auto",
      scrollHeight: 300,
      scrollTop: 40,
    });
    const group = new ScrollElement(timeline, true);

    expect(toolGroupConsumesUpwardNavigation(new ScrollElement(group))).toBe(false);
  });

  it.each(["hidden", "clip", "visible"])(
    "ignores a non-scrollable child with overflow-y %s",
    (overflowY) => {
      const group = new ScrollElement(null, true);
      const result = Object.assign(new ScrollElement(group), {
        overflowY,
        scrollHeight: 300,
        scrollTop: 40,
      });

      expect(toolGroupConsumesUpwardNavigation(new ScrollElement(result))).toBe(false);
    },
  );

  it("does not consume programmatic scrolling on an overflow-hidden group", () => {
    const group = Object.assign(new ScrollElement(null, true), {
      overflowY: "hidden",
      scrollHeight: 300,
      scrollTop: 40,
    });

    expect(toolGroupConsumesUpwardNavigation(group)).toBe(false);
  });
});

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";
const helloWorldTemplate: CodexArtifactTemplate = {
  artifactKind: "document",
  displayName: "Hello World",
  skillDirectory: "/Users/test/.codex/skills/artifact-template-hello-world",
  skillName: "artifact-template-hello-world",
};

describe("artifact template composer insertion", () => {
  it("does not insert an already-present prompt", () => {
    const prompt = "Create a document using this $artifact-template-hello-world about…";

    expect(codexArtifactTemplatePromptToAppend(prompt, helloWorldTemplate)).toBeNull();
  });
});

describe("draft hero submission transition", () => {
  it("does not dock the composer before a background submission", () => {
    expect(
      shouldDockDraftHeroForSubmission({
        isDraftHeroState: true,
        activeThreadKey: "environment-local:thread-1",
        submissionIntent: "background",
      }),
    ).toBe(false);
  });

  it("keeps the composer in the hero layout until navigation after server promotion", () => {
    expect(
      resolveDraftHeroState({
        isLocalDraftThread: false,
        hasTimelineEntries: true,
        isWorking: true,
        draftHeroDockRequested: false,
        backgroundSubmissionPending: true,
      }),
    ).toBe(true);
  });

  it("does not auto-navigate a background submission after server promotion", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef: { environmentId, threadId },
        serverThread: makeThread({ latestTurn: completedTurn }),
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });
});

describe("resolveThreadSwitchTimeline", () => {
  afterEach(() => {
    resetHeldThreadTimeline();
  });

  const held = { threadKey: "env-1:thread-a", entries: ["a1", "a2"] };

  it("keeps the previous thread's entries while the next thread is loading", () => {
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-b",
        nextEntries: [],
        lastReady: held,
      }),
    ).toEqual({ entries: ["a1", "a2"], displayThreadKey: "env-1:thread-a" });
  });

  it("shows the new thread once its detail is ready", () => {
    expect(
      resolveThreadSwitchTimeline({
        loading: false,
        activeThreadKey: "env-1:thread-b",
        nextEntries: ["b1"],
        lastReady: held,
      }),
    ).toEqual({ entries: ["b1"], displayThreadKey: "env-1:thread-b" });
  });

  it("does not invent a timeline on the first open of a thread", () => {
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-a",
        nextEntries: [],
        lastReady: null,
      }),
    ).toEqual({ entries: [], displayThreadKey: "env-1:thread-a" });
  });

  it("keeps the held thread workspace cwd with the snapshot", () => {
    rememberReadyThreadTimeline({
      ...held,
      markdownCwd: "/repo/a",
      workspaceRoot: "/repo/a",
    });
    expect(peekHeldThreadTimeline<string[]>()).toEqual({
      ...held,
      markdownCwd: "/repo/a",
      workspaceRoot: "/repo/a",
    });
  });

  it("survives a ChatView remount by remembering the last ready timeline", () => {
    rememberReadyThreadTimeline(held);
    expect(peekHeldThreadTimeline<string[]>()).toEqual(held);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-b",
        nextEntries: [],
      }),
    ).toEqual({ entries: ["a1", "a2"], displayThreadKey: "env-1:thread-a" });
  });

  it("paints a remembered destination instead of the last-viewed thread", () => {
    rememberReadyThreadTimeline(held);
    rememberReadyThreadTimeline({ threadKey: "env-1:thread-b", entries: ["b1", "b2"] });
    expect(peekRememberedThreadTimeline<string[]>("env-1:thread-a")).toEqual(["a1", "a2"]);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-a",
        nextEntries: [],
      }),
    ).toEqual({ entries: ["a1", "a2"], displayThreadKey: "env-1:thread-a" });
  });

  it("prefers live entries over a remembered snapshot", () => {
    rememberReadyThreadTimeline({ threadKey: "env-1:thread-b", entries: ["stale-b"] });
    expect(
      resolveThreadSwitchTimeline({
        loading: false,
        activeThreadKey: "env-1:thread-b",
        nextEntries: ["fresh-b"],
      }),
    ).toEqual({ entries: ["fresh-b"], displayThreadKey: "env-1:thread-b" });
  });

  it("does not keep a remembered snapshot on a resolved empty thread", () => {
    rememberReadyThreadTimeline(held);
    expect(
      resolveThreadSwitchTimeline({
        loading: false,
        activeThreadKey: "env-1:thread-a",
        nextEntries: [],
      }),
    ).toEqual({ entries: [], displayThreadKey: "env-1:thread-a" });
  });

  it("does not hold another environment's timeline across a jump", () => {
    expect(threadKeysShareEnvironment("env-1:thread-a", "env-2:thread-b")).toBe(false);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-2:thread-b",
        nextEntries: [],
        lastReady: held,
      }),
    ).toEqual({ entries: [], displayThreadKey: "env-2:thread-b" });
  });

  it("treats a foreign held timeline as paint-only", () => {
    expect(isPaintOnlyThreadTimeline("env-1:thread-a", "env-1:thread-b")).toBe(true);
    expect(isPaintOnlyThreadTimeline("env-1:thread-b", "env-1:thread-b")).toBe(false);
  });

  it("does not remember a timeline that still has handoff blob previews", () => {
    expect(
      timelineHasEphemeralPreviewUrls([
        {
          kind: "message",
          message: {
            id: MessageId.make("preview-message"),
            role: "user",
            text: "Preview",
            turnId: null,
            streaming: false,
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
            attachments: [
              {
                type: "image",
                id: "preview",
                name: "preview.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl: "blob:handoff",
              },
            ],
          },
        },
      ]),
    ).toBe(true);
    expect(
      timelineHasEphemeralPreviewUrls([
        {
          kind: "message",
          message: {
            id: MessageId.make("preview-message"),
            role: "user",
            text: "Preview",
            turnId: null,
            streaming: false,
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
            attachments: [
              {
                type: "image",
                id: "preview",
                name: "preview.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl: "https://cdn.example/a.png",
              },
            ],
          },
        },
      ]),
    ).toBe(false);
  });
});

describe("shouldReleaseTimelineAnchorForToolActivity", () => {
  const activeTurnId = TurnId.make("active-turn");
  const anchorMessageId = MessageId.make("anchored-message");
  const activeToolEntry = {
    id: "tool-entry",
    kind: "work" as const,
    createdAt: now,
    entry: {
      id: "active-tool",
      createdAt: now,
      turnId: activeTurnId,
      label: "Run command",
      tone: "tool" as const,
      command: "git status",
    },
  };

  it("releases the send anchor for tool activity in the active turn", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [activeToolEntry],
      }),
    ).toBe(true);
  });

  it("keeps the anchor while the user reads history", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: false,
        runningTurnId: activeTurnId,
        timelineEntries: [activeToolEntry],
      }),
    ).toBe(false);
  });

  it("ignores tool activity from earlier turns", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [
          {
            ...activeToolEntry,
            entry: {
              ...activeToolEntry.entry,
              turnId: TurnId.make("previous-turn"),
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("ignores thinking and error rows without tool activity", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [
          {
            ...activeToolEntry,
            entry: {
              id: "thinking-entry",
              createdAt: now,
              turnId: activeTurnId,
              label: "Thinking",
              tone: "thinking",
            },
          },
          {
            ...activeToolEntry,
            id: "error-entry",
            entry: {
              id: "error-entry",
              createdAt: now,
              turnId: activeTurnId,
              label: "Provider error",
              tone: "error",
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("does nothing without an anchor or running turn", () => {
    const input = {
      anchorMessageId,
      liveFollowEnabled: true,
      runningTurnId: activeTurnId,
      timelineEntries: [activeToolEntry],
    };

    expect(shouldReleaseTimelineAnchorForToolActivity({ ...input, anchorMessageId: null })).toBe(
      false,
    );
    expect(shouldReleaseTimelineAnchorForToolActivity({ ...input, runningTurnId: null })).toBe(
      false,
    );
  });
});

describe("environment reconnect warning grace", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a persistent reconnect after the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    scheduleEnvironmentReconnectWarning(showWarning);
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS - 1);
    expect(showWarning).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(showWarning).toHaveBeenCalledOnce();
  });

  it("cancels the warning when the connection recovers during the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    const cancel = scheduleEnvironmentReconnectWarning(showWarning);
    cancel();
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);

    expect(showWarning).not.toHaveBeenCalled();
  });

  it("does not reuse elapsed grace from another environment", () => {
    const anotherEnvironmentId = EnvironmentId.make("environment-remote");

    expect(hasEnvironmentReconnectWarningGraceElapsed(environmentId, environmentId)).toBe(true);
    expect(hasEnvironmentReconnectWarningGraceElapsed(anotherEnvironmentId, environmentId)).toBe(
      false,
    );
  });
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  threadId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("draft promotion during worktree setup", () => {
  const serverThreadRef = { environmentId, threadId };

  it.each([null, "idle", "starting", "ready"] as const)(
    "keeps the draft mounted while the first turn waits with session %s",
    (status) => {
      const serverThread = makeThread({
        messages: [
          {
            id: MessageId.make("submitted-message"),
            role: "user",
            text: "Start in a new worktree",
            turnId: null,
            createdAt: now,
            updatedAt: now,
            streaming: false,
          },
        ],
        session: status ? { ...readySession, status } : null,
      });

      expect(
        resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread,
          backgroundSubmissionPending: false,
        }),
      ).toBeNull();
    },
  );

  it("promotes when the provider starts the first turn", () => {
    const latestTurn = { ...completedTurn, state: "running" as const, completedAt: null };

    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({
          latestTurn,
          session: { ...readySession, status: "running", activeTurnId: latestTurn.turnId },
        }),
        backgroundSubmissionPending: false,
      }),
    ).toEqual(serverThreadRef);
  });

  it.each(["error", "stopped", "interrupted"] as const)(
    "promotes a startup that ends as %s before a turn starts",
    (status) => {
      expect(
        resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread: makeThread({ session: { ...readySession, status } }),
          backgroundSubmissionPending: false,
        }),
      ).toEqual(serverThreadRef);
    },
  );
});

describe("buildLoadingThreadFromShell", () => {
  it("preserves shell metadata and supplies empty detail collections", () => {
    const shell = {
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      session: null,
      latestUserMessageAt: now,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } satisfies ThreadShell;

    expect(buildLoadingThreadFromShell(shell)).toMatchObject({
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      branch: "main",
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
  });
});

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("buildThreadTurnInterruptInput", () => {
  it("targets the session's active running turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it.each(["ready", "starting"] as const)("omits a turn id when the session is %s", (status) => {
    expect(
      buildThreadTurnInterruptInput(makeThread({ session: { ...readySession, status } })),
    ).toEqual({ threadId });
  });

  it("omits a turn id when a running session has not projected its active turn yet", () => {
    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId: null,
          },
        }),
      ),
    ).toEqual({ threadId });
  });
});

describe("getAntigravitySendBlockReason", () => {
  const catalogModels: ServerProvider["models"] = [
    { slug: "gemini-pro", name: "Gemini Pro", isCustom: false, capabilities: null },
  ];

  function antigravity(overrides: Partial<ServerProvider> = {}): ServerProvider {
    return {
      driver: ProviderDriverKind.make("antigravity"),
      instanceId: ProviderInstanceId.make("google_work"),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      version: null,
      checkedAt: now,
      models: [],
      slashCommands: [],
      skills: [],
      ...overrides,
    };
  }

  it("blocks sends while the selected Antigravity account is signed out", () => {
    const provider = antigravity({
      status: "error",
      auth: { status: "unauthenticated" },
      models: catalogModels,
    });

    expect(getAntigravitySendBlockReason(provider, "gemini-pro")).toBe(
      "Sign in to Antigravity in provider settings before sending.",
    );
  });

  it("blocks sends until the selected Antigravity profile is installed", () => {
    expect(
      getAntigravitySendBlockReason(
        antigravity({ installed: false, models: catalogModels }),
        "gemini-pro",
      ),
    ).toBe("Install Antigravity in provider settings before sending.");
  });

  it("lets Antigravity check saved credentials when resuming after a restart", () => {
    const provider = antigravity({ status: "warning", auth: { status: "unknown" } });

    expect(getAntigravitySendBlockReason(provider, "gemini-pro")).toBeNull();
    expect(getAntigravitySendBlockReason(provider, ANTIGRAVITY_DEFAULT_MODEL)).toBeNull();
    expect(
      getAntigravitySendBlockReason({ ...provider, models: catalogModels }, "gemini-pro"),
    ).toBeNull();
    // A new thread or a default-model selection resolves to no model while the
    // catalog is empty; the actionable step is reloading the catalog.
    expect(getAntigravitySendBlockReason(provider, "")).toBe(
      "Refresh Antigravity models in provider settings before sending.",
    );
  });

  it("blocks saved model sends until Antigravity loads its account catalog", () => {
    expect(getAntigravitySendBlockReason(antigravity(), "gemini-pro")).toBe(
      "Refresh Antigravity models in provider settings before sending.",
    );
  });

  it("blocks an empty Antigravity selection after the catalog has loaded", () => {
    expect(getAntigravitySendBlockReason(antigravity({ models: catalogModels }), "")).toBe(
      "Choose an Antigravity model before sending.",
    );
  });

  it("blocks a saved model that a ready catalog no longer lists", () => {
    const provider = antigravity({ models: catalogModels });

    expect(getAntigravitySendBlockReason(provider, "saved-model-not-in-current-catalog")).toBe(
      "That Antigravity model is no longer available. Choose another model.",
    );
    expect(getAntigravitySendBlockReason(provider, "gemini-pro")).toBeNull();
    expect(getAntigravitySendBlockReason(provider, ANTIGRAVITY_DEFAULT_MODEL)).toBeNull();
  });

  it("allows a saved native model to retry after a provider error without changing it", () => {
    expect(
      getAntigravitySendBlockReason(
        antigravity({ status: "error", models: catalogModels }),
        "saved-model-not-in-current-catalog",
      ),
    ).toBeNull();
  });

  it("keeps existing send behavior for other providers", () => {
    expect(
      getAntigravitySendBlockReason(
        antigravity({
          driver: ProviderDriverKind.make("codex"),
          installed: false,
          auth: { status: "unknown" },
        }),
        "gpt-model",
      ),
    ).toBeNull();
  });
});

describe("buildRunningThreadTurnInterruptInput", () => {
  it("targets only the active turn of a running thread", () => {
    const activeTurnId = TurnId.make("turn-running");
    const runningThread = makeThread({
      session: {
        ...readySession,
        status: "running",
        activeTurnId,
      },
    });

    expect(buildRunningThreadTurnInterruptInput(runningThread, "running")).toEqual({
      threadId,
      turnId: activeTurnId,
    });
    expect(buildRunningThreadTurnInterruptInput(runningThread, "ready")).toBeNull();
    expect(
      buildRunningThreadTurnInterruptInput(makeThread({ session: readySession }), "ready"),
    ).toBeNull();
    expect(buildRunningThreadTurnInterruptInput(null, "disconnected")).toBeNull();
  });

  it("targets a running thread before its active turn has been projected", () => {
    const runningThread = makeThread({
      session: {
        ...readySession,
        status: "running",
        activeTurnId: null,
      },
    });

    expect(buildRunningThreadTurnInterruptInput(runningThread, "running")).toEqual({ threadId });
  });

  it("stops a turn that is still awaiting provider admission, like the Stop button", () => {
    const admittingThread = makeThread({
      session: { ...readySession, status: "starting", activeTurnId: null },
    });

    expect(buildRunningThreadTurnInterruptInput(admittingThread, "connecting")).toEqual({
      threadId,
    });
  });
});

describe("deriveLockedProvider for imported history", () => {
  function entry(driver: string, instanceId = driver, overrides: Partial<ServerProvider> = {}) {
    return deriveProviderInstanceEntries([
      {
        driver: ProviderDriverKind.make(driver),
        instanceId: ProviderInstanceId.make(instanceId),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: now,
        models: [],
        slashCommands: [],
        skills: [],
        ...overrides,
      },
    ])[0]!;
  }

  function importedThread(instanceId: ProviderInstanceId) {
    return makeThread({
      modelSelection: { instanceId, model: "default" },
      messages: [
        {
          id: MessageId.make(`import:${instanceId}:session:000000`),
          role: "user",
          text: "Continue the imported conversation",
          turnId: null,
          createdAt: now,
          updatedAt: now,
          streaming: false,
        },
      ],
    });
  }

  function selectComposerInstance(input: {
    readonly entries: ReadonlyArray<ReturnType<typeof entry>>;
    readonly draftActiveProvider: ProviderInstanceId | null;
    readonly threadInstanceId: ProviderInstanceId;
    readonly lockedProvider: ProviderDriverKind | null;
  }) {
    return resolveComposerInstanceSelection({
      entries: input.entries,
      draftActiveProvider: input.draftActiveProvider,
      sessionInstanceId: null,
      threadInstanceId: input.threadInstanceId,
      projectInstanceId: null,
      lockedProvider: input.lockedProvider,
      nowMs: Date.parse(now),
    });
  }

  it.each([
    ["claudeAgent", "claude_work"],
    ["codex", "codex_work"],
    ["ollama", "local_models"],
  ])("keeps imported %s history selectable through its custom instance", (driver, instanceId) => {
    const importedEntry = entry(driver, instanceId);
    const entries = [entry(driver === "codex" ? "claudeAgent" : "codex"), importedEntry];
    const thread = importedThread(importedEntry.instanceId);
    const lockedProvider = deriveLockedProvider({
      thread,
      selectedProvider: entries[0]!.instanceId,
      threadProvider: thread.modelSelection.instanceId,
      providers: entries.map((entry) => entry.snapshot),
    });

    expect(thread.session).toBeNull();
    expect(lockedProvider).toBe(driver);
    expect(
      selectComposerInstance({
        entries,
        draftActiveProvider: null,
        threadInstanceId: thread.modelSelection.instanceId,
        lockedProvider,
      }).entry?.instanceId,
    ).toBe(importedEntry.instanceId);
  });

  it("keeps the session driver authoritative over instance and draft selections", () => {
    const selected = entry("claudeAgent", "claude_work");
    const sessionEntry = entry("ollama", "local_models");
    const thread = importedThread(selected.instanceId);

    expect(
      deriveLockedProvider({
        thread: {
          ...thread,
          session: {
            ...readySession,
            providerName: sessionEntry.driverKind,
            providerInstanceId: sessionEntry.instanceId,
          },
        },
        selectedProvider: selected.instanceId,
        threadProvider: thread.modelSelection.instanceId,
        providers: [selected.snapshot, sessionEntry.snapshot],
      }),
    ).toBe(sessionEntry.driverKind);
  });

  it.each(["missing", "disabled"] as const)(
    "does not move imported history to another driver when its instance is %s",
    (state) => {
      const imported = entry("claudeAgent", "claude_work", { enabled: false });
      const other = entry("codex");
      const entries = state === "missing" ? [other] : [other, imported];
      const thread = importedThread(imported.instanceId);
      const lockedProvider = deriveLockedProvider({
        thread,
        selectedProvider: other.instanceId,
        threadProvider: thread.modelSelection.instanceId,
        providers: entries.map((entry) => entry.snapshot),
      });

      expect(lockedProvider).not.toBeNull();
      expect(
        selectComposerInstance({
          entries,
          draftActiveProvider: other.instanceId,
          threadInstanceId: imported.instanceId,
          lockedProvider,
        }).entry,
      ).toBeUndefined();
    },
  );

  it("leaves a new draft free to select a different driver", () => {
    const original = entry("claudeAgent", "claude_work");
    const selected = entry("codex", "codex_work");
    expect(
      deriveLockedProvider({
        thread: makeThread({
          modelSelection: { instanceId: original.instanceId, model: "default" },
        }),
        selectedProvider: selected.instanceId,
        threadProvider: original.instanceId,
        providers: [original.snapshot, selected.snapshot],
      }),
    ).toBeNull();
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("mergeFailedComposerSend", () => {
  it("puts a failed immediate send before a newer draft and deduplicates attachments", () => {
    expect(
      mergeFailedComposerSend({
        failedText: "failed first",
        currentText: "typed while sending",
        failedAttachments: [{ id: "failed" }, { id: "shared", source: "failed" }],
        currentAttachments: [{ id: "shared", source: "current" }, { id: "new" }],
      }),
    ).toEqual({
      text: "failed first\n\ntyped while sending",
      attachments: [{ id: "failed" }, { id: "shared", source: "current" }, { id: "new" }],
    });
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
    },
    {
      instanceId: ProviderInstanceId.make("grok"),
      driver: ProviderDriverKind.make("grok"),
      requiresNewThreadForModelChange: true,
    },
    {
      instanceId: ProviderInstanceId.make("prime"),
      driver: ProviderDriverKind.make("primeAgent"),
    },
  ];

  it("allows model changes before a provider session has started", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toBeNull();
  });

  it("allows unchanged model selections for restricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toBeNull();
  });

  it("blocks switching a started Prime Agent thread back to Prime Agent Default", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("prime"),
          model: "anthropic/claude-sonnet-4.5",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("prime"),
          model: "default",
        },
      }),
    ).toEqual({
      title: "Start a new chat to use Prime Agent Default",
      description:
        "Prime Agent cannot hand model choice back to its own default once a conversation is running.",
    });
  });

  it("allows a started Prime Agent thread to keep picking named models", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("prime"),
          model: "default",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("prime"),
          model: "anthropic/claude-sonnet-4.5",
        },
      }),
    ).toBeNull();
  });

  it("blocks every cross-instance change after a session starts", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toEqual({
      title: "Start a new chat to change providers",
      description:
        "A started thread stays bound to the exact provider account that created its session.",
    });
  });

  it("allows only available peers with the same exact continuation identity", () => {
    const compatibleProviders = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        continuation: { groupKey: "codex:home:shared" },
        enabled: true,
        installed: true,
        status: "ready" as const,
        auth: { status: "authenticated" as const },
      },
      {
        instanceId: ProviderInstanceId.make("codex_personal"),
        driver: ProviderDriverKind.make("codex"),
        continuation: { groupKey: "codex:home:shared" },
        enabled: true,
        installed: true,
        status: "ready" as const,
        auth: { status: "authenticated" as const },
      },
    ];
    const input = {
      providers: compatibleProviders,
      hasStartedSession: true,
      currentProviderInstanceId: ProviderInstanceId.make("codex"),
      currentModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.3-codex",
      },
      nextModelSelection: {
        instanceId: ProviderInstanceId.make("codex_personal"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    } as const;

    expect(getStartedThreadModelChangeBlockReason(input)).toBeNull();
    expect(
      getStartedThreadModelChangeBlockReason({
        ...input,
        providers: compatibleProviders.map((provider) =>
          provider.instanceId === ProviderInstanceId.make("codex_personal")
            ? { ...provider, availability: "unavailable" as const }
            : provider,
        ),
      }),
    ).toMatchObject({
      description: expect.stringContaining("unavailable"),
    });
  });

  it("lets a warning bound provider reconcile a stale picker selection", () => {
    const providersWithWarningBinding = providers.map((provider) =>
      provider.instanceId === ProviderInstanceId.make("prime")
        ? {
            ...provider,
            enabled: true,
            installed: true,
            status: "warning" as const,
            auth: { status: "authenticated" as const },
          }
        : provider,
    );
    expect(
      getStartedThreadModelChangeBlockReason({
        providers: providersWithWarningBinding,
        hasStartedSession: true,
        currentProviderInstanceId: ProviderInstanceId.make("prime"),
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("prime"),
          model: "anthropic/claude-sonnet-4.5",
        },
      }),
    ).toBeNull();
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("resolveBackgroundDraftWorkspaceOptions", () => {
  it("keeps New worktree selected without reusing the launched worktree", () => {
    expect(
      resolveBackgroundDraftWorkspaceOptions({
        envMode: "worktree",
        branch: "main",
        startFromOrigin: true,
      }),
    ).toEqual({
      envMode: "worktree",
      branch: "main",
      worktreePath: null,
      startFromOrigin: true,
    });
  });
});

describe("branchMismatchKey", () => {
  it("builds a key from thread id and both branches", () => {
    expect(branchMismatchKey("thread-1", { threadBranch: "feat/a", currentBranch: "feat/b" })).toBe(
      "thread-1:feat/a:feat/b",
    );
  });

  it("returns null without a thread or mismatch", () => {
    expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
    expect(branchMismatchKey("thread-1", null)).toBeNull();
  });
});

describe("shouldShowBranchMismatchBanner", () => {
  const base = {
    hasMismatch: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentMismatch: false,
  };

  it("stays hidden during passive browsing (even though the composer autofocuses)", () => {
    expect(shouldShowBranchMismatchBanner(base)).toBe(false);
  });

  it("shows once the composer has draft content", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, composerHasContent: true })).toBe(true);
  });

  it("stays mounted after the draft clears once shown for the current mismatch", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, wasShownForCurrentMismatch: true })).toBe(
      true,
    );
  });

  it("never shows when dismissed or without a mismatch", () => {
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, hasMismatch: false }),
    ).toBe(false);
  });
});

describe("shouldShowPlanFollowUpPrompt", () => {
  const base = {
    pendingUserInputCount: 0,
    interactionMode: "plan" as const,
    latestTurnSettled: true,
    hasActionableProposedPlan: true,
    hasComposerAttachments: false,
  };

  it("shows plan actions for a settled actionable plan without attachments", () => {
    expect(shouldShowPlanFollowUpPrompt(base)).toBe(true);
  });

  it("hides plan actions while the composer has staged attachments", () => {
    expect(shouldShowPlanFollowUpPrompt({ ...base, hasComposerAttachments: true })).toBe(false);
  });

  it("preserves the existing plan follow-up gates", () => {
    expect(shouldShowPlanFollowUpPrompt({ ...base, pendingUserInputCount: 1 })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, interactionMode: "default" })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, latestTurnSettled: false })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, hasActionableProposedPlan: false })).toBe(false);
  });
});

describe("session branch mismatch dismissal", () => {
  it("tracks dismissed keys and treats other keys as active", () => {
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(false);
    dismissBranchMismatchForSession("t1:a:b");
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(true);
    expect(isBranchMismatchDismissedForSession("t1:a:c")).toBe(false);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("writes errors for a shell-derived active server thread", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
  });

  it("requires an active server thread matching the environment, route, and target", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("startNewThreadForProject", () => {
  it("starts a thread through the supplied shared handler for the active project", () => {
    const calls: Array<{ environmentId: EnvironmentId; projectId: ProjectId }> = [];
    const projectRef = { environmentId, projectId };

    expect(
      startNewThreadForProject(projectRef, (nextProjectRef) => {
        calls.push(nextProjectRef);
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(calls).toEqual([projectRef]);
  });

  it("does nothing when the active project is unavailable", () => {
    let called = false;

    expect(
      startNewThreadForProject(null, () => {
        called = true;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("keeps a follow-up active while its provider session is starting", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "connecting",
        latestTurn: completedTurn,
        latestUserMessageId: MessageId.make("message-followup"),
        session: {
          ...readySession,
          status: "starting",
          updatedAt: "2026-03-29T00:01:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: newerTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: TurnId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: runningTurn.turnId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running turn", () => {
    const runningTurn = {
      ...completedTurn,
      state: "running" as const,
      completedAt: null,
    };
    const runningSession = {
      ...readySession,
      status: "running" as const,
      activeTurnId: runningTurn.turnId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestTurn: runningTurn,
        session: runningSession,
        messages: [
          {
            id: MessageId.make("message-before-steer"),
            role: "user",
            text: "Initial prompt",
            turnId: runningTurn.turnId,
            createdAt: runningTurn.requestedAt,
            updatedAt: runningTurn.requestedAt,
            streaming: false,
          },
        ],
      }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: MessageId.make("message-steer"),
        session: runningSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      latestUserMessageId: localDispatch.latestUserMessageId,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(
      hasServerAcknowledgedLocalDispatch({
        ...common,
        latestTurnStartFailureId: "turn-start-failure-1",
      }),
    ).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });

  it("acknowledges only a new turn-start failure", () => {
    const localDispatch = {
      ...createLocalDispatchSnapshot(makeThread()),
      latestTurnStartFailureId: "turn-start-failure-old",
    };
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      latestUserMessageId: localDispatch.latestUserMessageId,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        ...common,
        latestTurnStartFailureId: "turn-start-failure-old",
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        ...common,
        latestTurnStartFailureId: "turn-start-failure-new",
      }),
    ).toBe(true);
  });
});

describe("server pull request link changes", () => {
  it("follows a changed server PR link without replacing an unrelated open panel", () => {
    const previous = {
      projectId: ProjectId.make("project-1"),
      repository: "pingdotgg/t3code",
      number: 42,
      url: "https://github.com/pingdotgg/t3code/pull/42",
    };
    const current = {
      ...previous,
      number: 43,
      url: "https://github.com/pingdotgg/t3code/pull/43",
    };
    const surface = {
      id: "pull-request:previous",
      kind: "pull-request",
      projectId: previous.projectId,
      repository: "PingDotGG/T3Code",
      number: previous.number,
    } satisfies RightPanelSurface;

    expect(shouldRetargetThreadPullRequestPanel(previous, current, surface)).toBe(true);
    expect(shouldRetargetThreadPullRequestPanel(previous, previous, surface)).toBe(false);
    expect(shouldRetargetThreadPullRequestPanel(previous, null, surface)).toBe(false);
    expect(
      shouldRetargetThreadPullRequestPanel(previous, current, { ...surface, number: 99 }),
    ).toBe(false);
    expect(
      shouldRetargetThreadPullRequestPanel(previous, current, {
        ...surface,
        projectId: "another-project",
      }),
    ).toBe(false);
  });
});

describe("shouldRefocusComposerOnWindowFocus", () => {
  function element(
    tagName: string,
    options?: { editable?: boolean; role?: string; within?: string },
  ) {
    return {
      tagName,
      isContentEditable: options?.editable ?? false,
      getAttribute: (name: string) => (name === "role" ? (options?.role ?? null) : null),
      closest: (selector: string) =>
        options?.within !== undefined && selector.includes(options.within) ? ({} as Element) : null,
    };
  }

  it("refocuses when nothing or the body holds focus", () => {
    expect(shouldRefocusComposerOnWindowFocus(null)).toBe(true);
    expect(shouldRefocusComposerOnWindowFocus(element("BODY"))).toBe(true);
  });

  it("refocuses away from a plain button, such as a pull request tab", () => {
    expect(shouldRefocusComposerOnWindowFocus(element("BUTTON"))).toBe(true);
  });

  it("leaves other text fields alone", () => {
    expect(shouldRefocusComposerOnWindowFocus(element("INPUT"))).toBe(false);
    expect(shouldRefocusComposerOnWindowFocus(element("TEXTAREA"))).toBe(false);
    expect(shouldRefocusComposerOnWindowFocus(element("DIV", { editable: true }))).toBe(false);
    expect(shouldRefocusComposerOnWindowFocus(element("DIV", { role: "textbox" }))).toBe(false);
  });

  it("leaves a focused terminal alone in the drawer and the right panel", () => {
    expect(
      shouldRefocusComposerOnWindowFocus(element("BUTTON", { within: "data-terminal-owner" })),
    ).toBe(false);
  });

  it("leaves focus inside a dialog or popup alone", () => {
    expect(shouldRefocusComposerOnWindowFocus(element("BUTTON", { within: "dialog" }))).toBe(false);
    expect(shouldRefocusComposerOnWindowFocus(element("BUTTON", { within: "-popup" }))).toBe(false);
  });
});

describe("floating browser preview", () => {
  it("only hides the duplicate while the same browser is rendered in the panel", () => {
    expect(shouldRenderPreviewMiniPlayer(null, null)).toBe(false);
    expect(
      shouldRenderPreviewMiniPlayer("tab-1", {
        id: "browser:one",
        kind: "preview",
        resourceId: "tab-1",
      }),
    ).toBe(false);
    expect(
      shouldRenderPreviewMiniPlayer("tab-1", {
        id: "browser:two",
        kind: "preview",
        resourceId: "tab-2",
      }),
    ).toBe(true);
    expect(shouldRenderPreviewMiniPlayer("tab-1", { id: "diff", kind: "diff" })).toBe(true);
  });
});

describe("checkout Git memory", () => {
  it("answers from the last status seen for the same checkout", () => {
    rememberCheckoutIsRepo(environmentId, "/repo/plain-folder", false);
    expect(recallCheckoutIsRepo(environmentId, "/repo/plain-folder")).toBe(false);
    rememberCheckoutIsRepo(environmentId, "/repo/plain-folder", true);
    expect(recallCheckoutIsRepo(environmentId, "/repo/plain-folder")).toBe(true);
  });

  it("does not answer for a checkout it has not seen", () => {
    expect(recallCheckoutIsRepo(environmentId, "/repo/never-opened")).toBeUndefined();
    expect(recallCheckoutIsRepo(environmentId, null)).toBeUndefined();
  });

  it("keeps environments apart", () => {
    rememberCheckoutIsRepo(environmentId, "/repo/shared-path", false);
    expect(
      recallCheckoutIsRepo(EnvironmentId.make("env-other"), "/repo/shared-path"),
    ).toBeUndefined();
  });

  it("does not confuse an environment id containing the separator with a path", () => {
    rememberCheckoutIsRepo(EnvironmentId.make("env"), "a:b", false);
    expect(recallCheckoutIsRepo(EnvironmentId.make("env:a"), "b")).toBeUndefined();
  });
});

describe("threadShellHasStarted", () => {
  it("counts a thread that has a user message but no latest turn", () => {
    expect(
      threadShellHasStarted({ latestTurn: null, latestUserMessageAt: now, session: null }),
    ).toBe(true);
  });

  it("counts a thread with a live session and nothing else", () => {
    expect(
      threadShellHasStarted({
        latestTurn: null,
        latestUserMessageAt: null,
        session: {
          threadId,
          status: "starting",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
      }),
    ).toBe(true);
  });

  it("does not count a thread that never sent anything", () => {
    expect(
      threadShellHasStarted({ latestTurn: null, latestUserMessageAt: null, session: null }),
    ).toBe(false);
    expect(threadShellHasStarted(null)).toBe(false);
  });
});
