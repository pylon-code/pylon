import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, RunId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  resolveDefaultDiffGitScope,
  resolveThreadDiffPanelSelection,
  selectExplicitThreadDiffPanelSelection,
  selectThreadBranchBaseRef,
  selectThreadDiffPanelSelection,
  useDiffPanelStore,
} from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    }),
  );

  it("defaults each thread to Changes without requiring git status", () => {
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("defaults to Changes before a thread is selected", () => {
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, null)).toEqual({
      kind: "branch",
      baseRef: null,
    });
  });

  it("keeps a custom base when a generic open selects Changes again", () => {
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    store.selectGitScope(THREAD_REF, "branch");
    store.selectTurn(THREAD_REF, RunId.make("turn-1"));
    store.selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/release" });
  });

  it("preserves an explicit branch selection", () => {
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("clears incompatible selection fields when changing scopes", () => {
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/app.ts");
    store.selectGitScope(THREAD_REF, "unstaged");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });

    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, " origin/main ");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("clears a thread's turn and file when selecting working tree without changing another thread's branch base", () => {
    const otherThreadRef = scopeThreadRef(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-2"),
    );
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/app.ts");
    store.selectBranchBaseRef(otherThreadRef, "origin/main");

    store.selectGitScope(THREAD_REF, "unstaged");

    const { byThreadKey } = useDiffPanelStore.getState();
    expect(selectThreadDiffPanelSelection(byThreadKey, THREAD_REF)).toEqual({ kind: "unstaged" });
    expect(selectThreadDiffPanelSelection(byThreadKey, otherThreadRef)).toEqual({
      kind: "branch",
      baseRef: "origin/main",
    });

    store.selectGitScope(THREAD_REF, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/release" });
  });

  it("increments the reveal request when opening the same turn file again", () => {
    const turnId = RunId.make("turn-1");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "turn", turnId, filePath: "src/app.ts", revealRequestId: 2 });
  });

  it("restores the selected branch base after visiting another scope", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "unstaged");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("resets an explicit branch scope to working tree on generic reopen while retaining the custom base", () => {
    const otherThreadRef = scopeThreadRef(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-2"),
    );
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/feature");
    store.selectGitScope(THREAD_REF, "branch");
    store.selectBranchBaseRef(otherThreadRef, "origin/main");
    store.selectGitScope(otherThreadRef, "branch");

    // Generic reopen or thread switch unconditionally resets the active thread selection to working tree
    store.selectGitScope(THREAD_REF, "unstaged");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "unstaged",
    });
    // Other thread active selection is untouched
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, otherThreadRef),
    ).toEqual({
      kind: "branch",
      baseRef: "origin/main",
    });

    // When the user explicitly re-selects branch changes while the panel is open, the configured base is restored
    store.selectGitScope(THREAD_REF, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "branch",
      baseRef: "origin/feature",
    });
  });

  it("reconciles a missing turn selection to the latest available turn", () => {
    const missingTurnId = RunId.make("turn-missing");
    const latestTurnId = RunId.make("turn-latest");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, missingTurnId, "src/app.ts");
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [latestTurnId]);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "turn",
      turnId: latestTurnId,
      filePath: "src/app.ts",
      revealRequestId: 1,
    });
  });

  describe("default scope across server versions", () => {
    const resolveFor = (status: { readonly branchChanges?: unknown } | null | undefined) => {
      const state = useDiffPanelStore.getState();
      return resolveThreadDiffPanelSelection({
        explicit: selectExplicitThreadDiffPanelSelection(state.byThreadKey, THREAD_REF),
        defaultScope: resolveDefaultDiffGitScope(status),
        branchBaseRef: selectThreadBranchBaseRef(state.branchBaseRefByThreadKey, THREAD_REF),
      });
    };
    const branchChanges = { baseRef: "main", insertions: 3, deletions: 1 };

    it("opens Changes when the server reports Changes totals", () => {
      expect(resolveDefaultDiffGitScope({ branchChanges })).toBe("branch");
      expect(resolveFor({ branchChanges })).toEqual({ kind: "branch", baseRef: null });
    });

    it("opens Uncommitted on an older server so the view matches the uncommitted counts", () => {
      expect(resolveDefaultDiffGitScope({})).toBe("unstaged");
      expect(resolveFor({})).toEqual({ kind: "unstaged" });
    });

    it("assumes Changes until status loads, then follows it", () => {
      expect(resolveFor(undefined)).toEqual({ kind: "branch", baseRef: null });
      expect(resolveFor(null)).toEqual({ kind: "branch", baseRef: null });
      expect(resolveFor({})).toEqual({ kind: "unstaged" });
    });

    it("returns a generic reopen to the default scope while keeping the custom base", () => {
      const store = useDiffPanelStore.getState();
      store.selectBranchBaseRef(THREAD_REF, "origin/release");
      store.selectTurn(THREAD_REF, RunId.make("turn-1"));
      store.selectBranchBaseRef(THREAD_REF, "origin/release");
      store.selectDefaultGitScope(THREAD_REF);

      expect(
        selectExplicitThreadDiffPanelSelection(
          useDiffPanelStore.getState().byThreadKey,
          THREAD_REF,
        ),
      ).toBeUndefined();
      expect(resolveFor({ branchChanges })).toEqual({ kind: "branch", baseRef: "origin/release" });
      expect(resolveFor({})).toEqual({ kind: "unstaged" });
    });

    it("keeps an explicit choice regardless of server version", () => {
      useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");
      expect(resolveFor({})).toEqual({ kind: "branch", baseRef: null });
      useDiffPanelStore.getState().selectGitScope(THREAD_REF, "unstaged");
      expect(resolveFor({ branchChanges })).toEqual({ kind: "unstaged" });
    });
  });
});
