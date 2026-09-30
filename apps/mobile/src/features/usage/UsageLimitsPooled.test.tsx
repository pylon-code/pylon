import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ presentations: new Map(), navigate: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.presentations }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("react-native-svg", () => ({
  Svg: "Svg",
  Defs: "Defs",
  Path: "Path",
  Pattern: "Pattern",
  Rect: "Rect",
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../components/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: {} }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: null },
}));
vi.mock("./UsageLimitsSection", () => ({ ResetCredits: () => null }));
vi.mock("./usageProviders", () => ({
  useProviderColors: () => ({ codex: "#000", claude: "#fff" }),
}));

import { UsageLimitsSection } from "./UsageLimitsPooled";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const now = Date.parse("2026-09-03T12:00:00Z");
const home = EnvironmentId.make("home");
const windows: readonly ServerProviderUsageWindow[] = [
  { id: "totalPercentUsed", kind: "monthly", label: "Monthly", usedPercent: 15 },
  { id: "apiPercentUsed", kind: "monthly", label: "Monthly · API", usedPercent: 49 },
  { id: "autoPercentUsed", kind: "monthly", label: "Monthly · Auto", usedPercent: 9 },
];
function presentation(readings: readonly ServerProviderUsageWindow[]) {
  const provider = {
    instanceId: ProviderInstanceId.make("cursor"),
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "cursor@example.com" },
    checkedAt: "2026-09-03T11:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-09-03T11:00:00Z", windows: readings },
  } satisfies ServerProvider;
  return { entry: { target: { label: "Home" } }, serverConfig: { providers: [provider] } };
}

describe("mobile Cursor Limits", () => {
  it("keeps pool labels, older readings and account navigation correct when the selection changes", async () => {
    state.presentations = new Map([[home, presentation(windows)]]);
    state.navigate.mockReset();
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <UsageLimitsSection
            now={now}
            failedLabels={[]}
            selectedEnvironmentIds={new Set([home])}
          />,
        );
      });
      let tree = JSON.stringify(renderer?.toJSON());
      expect(tree).toContain("Cursor Models");
      expect(tree).toContain("Other Models");
      expect(tree).toContain("Auto can use either pool.");
      expect(tree).not.toContain("Overall");
      const open = renderer?.root.findAll(
        (node) => node.props.accessibilityHint === "Show account details",
      )[0];
      await act(async () => open?.props.onPress());
      expect(state.navigate).toHaveBeenCalledWith(
        "SettingsSheet",
        expect.objectContaining({
          params: expect.objectContaining({
            params: expect.objectContaining({
              windowId: "autoPercentUsed",
              environmentIds: [home],
            }),
          }),
        }),
      );
      state.presentations = new Map([[home, presentation([windows[0]!])]]);
      await act(async () =>
        renderer?.update(
          <UsageLimitsSection
            now={now}
            failedLabels={[]}
            selectedEnvironmentIds={new Set([home])}
          />,
        ),
      );
      tree = JSON.stringify(renderer?.toJSON());
      expect(tree).toContain("Overall");
      expect(tree).not.toContain("Cursor Models");
      await act(async () =>
        renderer?.update(
          <UsageLimitsSection now={now} failedLabels={[]} selectedEnvironmentIds={new Set()} />,
        ),
      );
      tree = JSON.stringify(renderer?.toJSON());
      expect(tree).not.toContain("Overall");
      expect(tree).toContain("Select an environment to see limits.");
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
});
