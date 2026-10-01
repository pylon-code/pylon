import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  View: "View",
  useWindowDimensions: () => ({ width: 390 }),
}));
vi.mock("@legendapp/list/react-native", () => ({ useRecyclingState: () => [false, vi.fn()] }));
vi.mock("react-native-svg", () => ({ default: "Svg", Circle: "Circle", Path: "Path" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/ControlPill", () => ({ ControlPillMenu: "ControlPillMenu" }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: "EnvironmentMachineSymbol",
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: "ProjectFavicon" }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../state/use-thread-pr", () => ({ useThreadPr: () => null }));
vi.mock("./queued-message-icon", () => ({ QueuedMessageIcon: "QueuedMessageIcon" }));
vi.mock("./thread-search-match", () => ({ ThreadSearchMatchExcerpt: "ThreadSearchMatchExcerpt" }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: "light",
    materialYouStyleLayoutActive: false,
  }),
}));
vi.mock("../home/thread-swipe-actions", () => ({
  ThreadSwipeable: (props: { readonly children: (close: () => void) => ReactNode }) =>
    props.children(() => {}),
}));

import { ControlPillMenu } from "../../components/ControlPill";
import { ThreadListRow } from "./thread-list-items";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const thread: EnvironmentThreadShell = {
  environmentId: EnvironmentId.make("environment-a"),
  id: ThreadId.make("thread-a"),
  projectId: ProjectId.make("project-a"),
  title: "Thread A",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

function menu(renderer: ReactTestRenderer) {
  // The renderer's native interop props are untyped; recover the component contract.
  return renderer.root.findByType(ControlPillMenu).props as ComponentProps<typeof ControlPillMenu>;
}

function checkedOptions(actions: MenuAction[]) {
  return actions
    .find((action) => action.id === "auto-settle")
    ?.subactions?.map((action) => ({
      id: action.id,
      state: action.state,
    }));
}

describe("legacy thread auto-settle menu", () => {
  it.each(["compact", "sidebar"] as const)(
    "updates the %s row's checked setting and dispatches for its current environment/thread",
    async (variant) => {
      const setAutoSettle = vi.fn();
      const archive = vi.fn();
      const baseProps = {
        variant,
        environmentLabel: null,
        projectCwd: null,
        isLast: true,
        onSelectThread: vi.fn(),
        onArchiveThread: archive,
        onDeleteThread: vi.fn(),
        onNewThreadOnBranch: vi.fn(),
        onRenameThread: vi.fn(),
        onRegenerateThreadTitle: vi.fn(),
        titleRegenerationSupported: false,
        autoSettleOptOutSupported: true,
        onSetThreadAutoSettle: setAutoSettle,
        onSwipeableWillOpen: vi.fn(),
        onSwipeableClose: vi.fn(),
      } satisfies Omit<ComponentProps<typeof ThreadListRow>, "thread">;
      let renderer: ReactTestRenderer | undefined;
      try {
        await act(async () => {
          renderer = create(<ThreadListRow {...baseProps} thread={thread} />);
        });
        expect(checkedOptions(menu(renderer!).actions)).toEqual([
          { id: "auto-settle:enabled", state: "on" },
          { id: "auto-settle:disabled", state: "off" },
        ]);
        await act(async () => {
          menu(renderer!).onPressAction?.({ nativeEvent: { event: "auto-settle:disabled" } });
        });
        expect(setAutoSettle).toHaveBeenLastCalledWith(thread, false);
        const held = { ...thread, autoSettleDisabledAt: "2026-09-30T00:00:00.000Z" };
        await act(async () => renderer!.update(<ThreadListRow {...baseProps} thread={held} />));
        expect(checkedOptions(menu(renderer!).actions)).toEqual([
          { id: "auto-settle:enabled", state: "off" },
          { id: "auto-settle:disabled", state: "on" },
        ]);
        const next = {
          ...held,
          environmentId: EnvironmentId.make("environment-b"),
          id: ThreadId.make("thread-b"),
        };
        await act(async () => renderer!.update(<ThreadListRow {...baseProps} thread={next} />));
        await act(async () => {
          menu(renderer!).onPressAction?.({ nativeEvent: { event: "auto-settle:enabled" } });
          menu(renderer!).onPressAction?.({ nativeEvent: { event: "archive" } });
        });
        expect(setAutoSettle).toHaveBeenLastCalledWith(next, true);
        expect(archive).toHaveBeenLastCalledWith(next);
        await act(async () => {
          renderer!.update(
            <ThreadListRow {...baseProps} autoSettleOptOutSupported={false} thread={next} />,
          );
        });
        expect(checkedOptions(menu(renderer!).actions)).toBeUndefined();
        expect(menu(renderer!).actions.map((action) => action.id)).toContain("archive");
        // Reconnecting to an updated environment restores the persisted checked state.
        await act(async () => renderer!.update(<ThreadListRow {...baseProps} thread={next} />));
        expect(checkedOptions(menu(renderer!).actions)?.[1]?.state).toBe("on");
      } finally {
        await act(async () => renderer?.unmount());
      }
    },
  );
});
