import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { AppText } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";

const state = vi.hoisted(() => ({ environments: [] as EnvironmentUsageStatus[] }));
vi.mock("../../state/usage", () => ({
  useUsage: (_input: unknown, selected: ReadonlySet<EnvironmentId> | null) => ({
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    environments: state.environments,
    selectedEnvironments:
      selected === null
        ? state.environments
        : state.environments.filter((entry) => selected.has(entry.environmentId)),
    isPending: false,
    isPartial: false,
    refresh: vi.fn(async () => {}),
  }),
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => false,
  useNavigation: () => ({ setOptions: vi.fn(), goBack: vi.fn() }),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Pressable: "Pressable",
  RefreshControl: "RefreshControl",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("react-native-reanimated", () => {
  const transition = {
    duration() {
      return this;
    },
    easing() {
      return this;
    },
    reduceMotion() {
      return this;
    },
  };
  return {
    default: { View: "View" },
    FadeIn: transition,
    LinearTransition: transition,
    ReduceMotion: { System: "system" },
    Easing: { cubic: "cubic", out: () => "out" },
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../components/AndroidScreenHeader", () => ({
  AndroidScreenHeader: ({ trailing }: { trailing: ReactNode }) => trailing,
}));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ControlPill", () => ({ ControlPillMenu: "Menu" }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./UsageDailyChart", () => ({ UsageDailyChart: () => null }));
vi.mock("./UsageLimitsSection", () => ({
  useRefreshLimits: () => ({ now: 0, refreshing: false, failedLabels: [], refresh: vi.fn() }),
}));
vi.mock("./UsageLimitsPooled", () => ({ UsageLimitsSection: () => null }));
vi.mock("./usageProviders", () => ({
  PROVIDER_LABEL: { opencode: "OpenCode", codex: "Codex" },
  useProviderColors: () => ({ opencode: "#000", codex: "#fff" }),
  useUsageMixColors: () => ({
    input: "#111",
    cacheRead: "#222",
    cacheWrite: "#333",
    output: "#444",
    other: "#555",
    standard: "#666",
    fast: "#777",
    ultrafast: "#888",
  }),
}));

import { UsageRouteScreen } from "./UsageRouteScreen";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function environment(): EnvironmentUsageStatus {
  return {
    environmentId: EnvironmentId.make("desktop"),
    label: "Desktop",
    isPending: false,
    isConnected: true,
    error: null,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-08-11T12:37:00Z",
      timeZone: "UTC",
      sinceDay: UsageDay.make("2026-08-10"),
      untilDay: UsageDay.make("2026-08-11"),
      buckets: [],
      sources: [
        {
          fingerprint: {
            hostId: "host",
            provider: "opencode",
            resolvedHomePath: "/opencode",
            volumeId: "volume",
          },
          status: "partial",
          scannedFiles: 1,
          skippedFiles: 1,
          malformedRecords: 0,
          distinctSessions: 0,
          message: "One history file could not be read.",
        },
      ],
      pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    },
  };
}
describe("mobile usage source coverage", () => {
  it("shows history scan problems only for selected environments and removes recovered warnings", async () => {
    state.environments = [environment()];
    let renderer: ReactTestRenderer | undefined;
    const displayedText = () =>
      (renderer?.root.findAllByType(AppText) ?? [])
        .flatMap((node) =>
          node.children.filter((child) => typeof child === "string" || typeof child === "number"),
        )
        .join(" ");
    try {
      await act(async () => {
        renderer = create(<UsageRouteScreen />);
      });
      expect(displayedText()).not.toContain("One history file could not be read.");
      const usageTab = renderer?.root.findByProps({
        accessibilityLabel: "Usage",
        accessibilityRole: "tab",
      });
      await act(async () => usageTab?.props.onPress());
      let tree = displayedText();
      expect(tree).toContain("One history file could not be read.");
      expect(tree).toContain("Desktop");
      expect(tree).toContain("OpenCode");
      const filter = renderer?.root.findByType(ControlPillMenu);
      expect(filter?.props.actions[1].subtitle).toBe("History incomplete");
      await act(async () => filter?.props.onPressAction({ nativeEvent: { event: "desktop" } }));
      expect(displayedText()).not.toContain("One history file could not be read.");
      await act(async () =>
        renderer?.root
          .findByType(ControlPillMenu)
          .props.onPressAction({ nativeEvent: { event: "all" } }),
      );
      expect(displayedText()).toContain("One history file could not be read.");
      const current = state.environments[0]!;
      if (current.summary === null) throw new Error("Missing fixture summary");
      state.environments = [
        {
          ...current,
          summary: {
            ...current.summary,
            sources: current.summary.sources.map((source) => ({
              ...source,
              status: "ok" as const,
            })),
          },
        },
      ];
      await act(async () => renderer?.update(<UsageRouteScreen />));
      tree = displayedText();
      expect(tree).not.toContain("One history file could not be read.");
      expect(renderer?.root.findByType(ControlPillMenu).props.actions[1].subtitle).toBe(
        "Usage up to date",
      );
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
});
