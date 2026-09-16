import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  aggregateFilesChanged,
  defaultTitleFor,
  delegatedChildPrefix,
  delegatedThreadId,
  deriveDelegatedThreadState,
  isChildOfParent,
  isDelegatedThreadId,
  isLiveDelegatedState,
  isValidDelegationKey,
  resolveDelegatedModel,
  resolveDelegatedRuntimeMode,
  selectAssistantMessage,
  truncateText,
} from "./logic.ts";

const NOW = "2026-09-15T12:00:00.000Z";
const PARENT = ThreadId.make("thread-parent");
const CHILD = ThreadId.make("delegated:thread-parent:0000000000000000");
const sha256Hex = (input: string) => NodeCrypto.createHash("sha256").update(input).digest("hex");

function shell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: CHILD,
    projectId: ProjectId.make("project-1"),
    title: "child",
    modelSelection: {
      instanceId: ProviderInstanceId.make("antigravity"),
      model: "antigravity-default",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function turn(overrides: Partial<OrchestrationLatestTurn> = {}): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make("turn-1"),
    state: "running",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: null,
    assistantMessageId: null,
    ...overrides,
  };
}

function session(overrides: Partial<OrchestrationSession> = {}): OrchestrationSession {
  return {
    threadId: CHILD,
    status: "ready",
    providerName: "antigravity",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function message(id: string, overrides: Partial<OrchestrationMessage> = {}): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role: "assistant",
    text: id,
    turnId: null,
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("delegation keys and ids", () => {
  it("accepts 1-64 letters, digits, underscores, and hyphens only", () => {
    expect(isValidDelegationKey("review-auth_1")).toBe(true);
    expect(isValidDelegationKey("x".repeat(64))).toBe(true);
    expect(isValidDelegationKey("")).toBe(false);
    expect(isValidDelegationKey("has space")).toBe(false);
    expect(isValidDelegationKey("colon:key")).toBe(false);
    expect(isValidDelegationKey("x".repeat(65))).toBe(false);
  });

  it("derives a stable child id that embeds the parent", () => {
    const id = delegatedThreadId(PARENT, "k1", sha256Hex);
    expect(id).toBe(`delegated:thread-parent:${sha256Hex("thread-parent\nk1").slice(0, 16)}`);
    expect(delegatedThreadId(PARENT, "k1", sha256Hex)).toBe(id);
    expect(delegatedThreadId(PARENT, "k2", sha256Hex)).not.toBe(id);
    expect(isDelegatedThreadId(id)).toBe(true);
    expect(isDelegatedThreadId(PARENT)).toBe(false);
    expect(delegatedChildPrefix(PARENT)).toBe("delegated:thread-parent:");
    expect(id.startsWith(delegatedChildPrefix(PARENT))).toBe(true);
  });

  it("matches children of exactly one parent", () => {
    const importParent = ThreadId.make("import:codex");
    const longerParent = ThreadId.make("import:codex:session-9");
    const child = delegatedThreadId(longerParent, "k1", sha256Hex);
    expect(isChildOfParent(child, longerParent)).toBe(true);
    expect(child.startsWith(delegatedChildPrefix(importParent))).toBe(true);
    expect(isChildOfParent(child, importParent)).toBe(false);
    expect(isChildOfParent(`${delegatedChildPrefix(PARENT)}not-a-hash`, PARENT)).toBe(false);
  });
});

describe("deriveDelegatedThreadState", () => {
  it("applies the rules in order", () => {
    expect(deriveDelegatedThreadState(shell({ archivedAt: NOW, latestTurn: turn() }))).toBe(
      "archived",
    );
    expect(deriveDelegatedThreadState(shell())).toBe("queued");
    expect(deriveDelegatedThreadState(shell({ session: session({ status: "error" }) }))).toBe(
      "error",
    );
    expect(deriveDelegatedThreadState(shell({ latestTurn: turn() }))).toBe("running");
    expect(deriveDelegatedThreadState(shell({ latestTurn: turn({ state: "error" }) }))).toBe(
      "error",
    );
    expect(deriveDelegatedThreadState(shell({ latestTurn: turn({ state: "interrupted" }) }))).toBe(
      "interrupted",
    );
    const completed = turn({ state: "completed", completedAt: NOW });
    expect(deriveDelegatedThreadState(shell({ latestTurn: completed }))).toBe("completed");
    expect(deriveDelegatedThreadState(shell({ latestTurn: completed, session: session() }))).toBe(
      "completed",
    );
    expect(
      deriveDelegatedThreadState(shell({ latestTurn: completed, backgroundLiveness: "working" })),
    ).toBe("running");
    expect(
      deriveDelegatedThreadState(
        shell({ latestTurn: completed, backgroundLiveness: "monitoring" }),
      ),
    ).toBe("completed");
    expect(
      deriveDelegatedThreadState(
        shell({
          latestTurn: completed,
          session: session({ status: "running", activeTurnId: TurnId.make("turn-2") }),
        }),
      ),
    ).toBe("running");
  });

  it("treats a turn waiting for admission as live, not as the previous result", () => {
    const pending = session({
      status: "starting",
      activeTurnId: null,
      pendingTurnRequestId: CommandId.make("server:mcp-delegate-turn:child:confirm"),
    });
    const completed = turn({ state: "completed", completedAt: NOW });
    expect(deriveDelegatedThreadState(shell({ latestTurn: completed, session: pending }))).toBe(
      "running",
    );
    expect(deriveDelegatedThreadState(shell({ session: pending }))).toBe("queued");
    expect(
      deriveDelegatedThreadState(
        shell({ latestTurn: completed, session: session({ status: "starting" }) }),
      ),
    ).toBe("running");
  });

  it("treats a first turn stopped before admission as interrupted, not queued forever", () => {
    for (const status of ["stopped", "interrupted", "ready", "idle"] as const) {
      expect(deriveDelegatedThreadState(shell({ session: session({ status }) }))).toBe(
        "interrupted",
      );
    }
  });

  it("ignores a stale pending admission id on a stopped session", () => {
    const stale = session({
      status: "stopped",
      activeTurnId: null,
      pendingTurnRequestId: CommandId.make("server:mcp-delegate-turn:child:initial"),
    });
    expect(deriveDelegatedThreadState(shell({ session: stale }))).toBe("interrupted");
    expect(
      deriveDelegatedThreadState(
        shell({ latestTurn: turn({ state: "completed", completedAt: NOW }), session: stale }),
      ),
    ).toBe("completed");
  });

  it("reports a failed admission as an error", () => {
    const failed = session({
      status: "ready",
      failedTurnRequestId: CommandId.make("server:mcp-delegate-turn:child:initial"),
    });
    expect(deriveDelegatedThreadState(shell({ session: failed }))).toBe("error");
    expect(
      deriveDelegatedThreadState(
        shell({ latestTurn: turn({ state: "completed", completedAt: NOW }), session: failed }),
      ),
    ).toBe("error");
  });

  it("treats only queued and running as live", () => {
    expect(isLiveDelegatedState("queued")).toBe(true);
    expect(isLiveDelegatedState("running")).toBe(true);
    for (const state of ["completed", "interrupted", "error", "archived"] as const) {
      expect(isLiveDelegatedState(state)).toBe(false);
    }
  });
});

describe("results", () => {
  it("aggregates files across checkpoints, latest kind wins, counts summed", () => {
    const checkpoint = (
      files: OrchestrationCheckpointSummary["files"],
    ): Pick<OrchestrationCheckpointSummary, "files"> => ({ files });
    expect(
      aggregateFilesChanged([
        checkpoint([{ path: "a.ts", kind: "added", additions: 1, deletions: 0 }]),
        checkpoint([
          { path: "a.ts", kind: "modified", additions: 2, deletions: 1 },
          { path: "b.ts", kind: "deleted", additions: 0, deletions: 3 },
        ]),
      ]),
    ).toEqual([
      { path: "a.ts", kind: "modified", additions: 3, deletions: 1 },
      { path: "b.ts", kind: "deleted", additions: 0, deletions: 3 },
    ]);
  });

  it("truncates and titles", () => {
    expect(truncateText("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(truncateText("abc", 3)).toEqual({ text: "abc", truncated: false });
    expect(defaultTitleFor("Fix the login bug\n\nDetails")).toBe("Fix the login bug");
    expect(defaultTitleFor("  \nsecond line")).toBe("Delegated task");
    expect(defaultTitleFor("x".repeat(100))).toHaveLength(80);
  });

  it("selects the referenced assistant message, else the last settled one", () => {
    const thread = (
      value: Pick<OrchestrationThread, "latestTurn" | "messages">,
    ): Pick<OrchestrationThread, "latestTurn" | "messages"> => value;
    expect(selectAssistantMessage(thread({ latestTurn: null, messages: [] }))).toBeNull();
    const messages = [
      message("m1"),
      message("m2"),
      message("m3", { streaming: true }),
      message("u1", { role: "user" }),
    ];
    expect(selectAssistantMessage(thread({ latestTurn: null, messages }))?.id).toBe("m2");
    expect(
      selectAssistantMessage(
        thread({
          latestTurn: turn({ assistantMessageId: MessageId.make("m3") }),
          messages,
        }),
      )?.id,
    ).toBe("m2");
    expect(
      selectAssistantMessage(
        thread({
          latestTurn: turn({ state: "completed", assistantMessageId: MessageId.make("m1") }),
          messages,
        }),
      )?.id,
    ).toBe("m1");
  });
});

describe("model and runtime mode policy", () => {
  const snapshot = (
    models: ServerProvider["models"],
  ): Pick<ServerProvider, "driver" | "models"> => ({
    driver: ProviderDriverKind.make("antigravity"),
    models,
  });
  const gemini = {
    slug: "gemini-3-pro",
    name: "Gemini 3 Pro",
    isCustom: false,
    capabilities: null,
    aliases: ["antigravity-default"],
    isDefault: true,
  };
  const claude = { slug: "claude-opus", name: "Claude", isCustom: false, capabilities: null };

  it("resolves requested slugs and aliases to a slug", () => {
    const provider = snapshot([gemini, claude]);
    expect(resolveDelegatedModel(provider, undefined)).toEqual({ ok: true, model: "gemini-3-pro" });
    expect(resolveDelegatedModel(provider, "antigravity-default")).toEqual({
      ok: true,
      model: "gemini-3-pro",
    });
    expect(resolveDelegatedModel(provider, "claude-opus")).toEqual({
      ok: true,
      model: "claude-opus",
    });
    expect(resolveDelegatedModel(provider, "nope")).toEqual({ ok: false });
  });

  it("falls back to the driver default only when no model is requested", () => {
    expect(resolveDelegatedModel(snapshot([]), undefined)).toEqual({
      ok: true,
      model: "antigravity-default",
    });
    const unknownDriver: Pick<ServerProvider, "driver" | "models"> = {
      driver: ProviderDriverKind.make("unknown-driver"),
      models: [],
    };
    expect(resolveDelegatedModel(unknownDriver, undefined)).toEqual({ ok: false });
  });

  it("never lets a child run with more autonomy than its parent", () => {
    expect(resolveDelegatedRuntimeMode("full-access", undefined)).toEqual({
      ok: true,
      mode: "full-access",
    });
    expect(resolveDelegatedRuntimeMode("full-access", "approval-required")).toEqual({
      ok: true,
      mode: "approval-required",
    });
    expect(resolveDelegatedRuntimeMode("approval-required", "full-access")).toEqual({
      ok: false,
      reason: "escalation",
    });
    expect(resolveDelegatedRuntimeMode("auto", "auto-accept-edits")).toEqual({
      ok: false,
      reason: "escalation",
    });
    expect(resolveDelegatedRuntimeMode("full-access", "auto")).toEqual({
      ok: false,
      reason: "escalation",
    });
  });
});
