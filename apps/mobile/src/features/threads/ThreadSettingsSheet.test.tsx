import { ProviderInstanceId } from "@t3tools/contracts";
import {
  formatModelChangeDisabledReason,
  PRIME_AGENT_DEFAULT_MODEL_CHANGE_DESCRIPTION,
  STARTED_THREAD_MODEL_CHANGE_DESCRIPTION,
} from "@t3tools/shared/model";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ModelOption } from "../../lib/modelOptions";

vi.mock("react-native", () => ({
  Alert: {},
  Platform: { OS: "ios", Version: 26 },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: "AnimatedView" },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: { duration: vi.fn() },
}));
vi.mock("@legendapp/list/reanimated", () => ({ AnimatedLegendList: "AnimatedLegendList" }));
vi.mock("@react-navigation/elements", () => ({ HeaderHeightContext: {} }));
vi.mock("@react-navigation/native", () => ({ useNavigation: vi.fn(), useRoute: vi.fn() }));
vi.mock("@react-navigation/native-stack", () => ({ createNativeStackNavigator: () => ({}) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: vi.fn() }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/AndroidScreenHeader", () => ({
  AndroidScreenHeader: "AndroidScreenHeader",
}));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: "ProviderIcon" }));
vi.mock("../../components/ThemedSwitch", () => ({ ThemedSwitch: "ThemedSwitch" }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: vi.fn() }));
vi.mock("../../native/StackHeader", () => ({
  NativeHeaderToolbar: "NativeHeaderToolbar",
  NativeStackScreenOptions: "NativeStackScreenOptions",
  nativeHeaderScrollEdgeEffects: vi.fn(),
}));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: true }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("./new-task-flow-provider", () => ({ useNewTaskFlow: vi.fn() }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ materialYouStyleLayoutActive: false }),
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  createNativeMailSearchToolbarItem: vi.fn(),
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET: 0,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED: true,
}));

import { ModelRow } from "./ThreadSettingsSheet";

type ElementProps = {
  readonly children?: ReactNode;
  readonly numberOfLines?: number;
};
function elements(node: ReactNode): ReadonlyArray<ReactElement<ElementProps>> {
  if (node === null || node === undefined || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!("props" in node)) return [];
  const element = node as ReactElement<ElementProps>;
  return [element, ...elements(element.props.children)];
}

const option: ModelOption = {
  key: "primeAgent:default",
  label: "Prime Agent Default",
  subtitle: "Prime account",
  providerKey: "primeAgent",
  providerLabel: "Prime Agent",
  providerDriver: "primeAgent",
  isDefault: true,
  isLegacy: false,
  capabilities: null,
  selection: { instanceId: ProviderInstanceId.make("primeAgent"), model: "default" },
};
const rowProps = { option, selected: false, isFirst: true, isLast: true, onPress: vi.fn() };

describe("ThreadSettingsSheet model row", () => {
  it.each([PRIME_AGENT_DEFAULT_MODEL_CHANGE_DESCRIPTION, STARTED_THREAD_MODEL_CHANGE_DESCRIPTION])(
    "exposes the entire disabled explanation visually and to accessibility: %s",
    (description) => {
      const disabledReason = formatModelChangeDisabledReason(description);
      const row = ModelRow({ ...rowProps, disabledReason });
      const captions = elements(row).filter((element) => element.props.children === disabledReason);
      expect(captions).toHaveLength(1);
      // The native Text must be allowed to measure all lines of the new-thread remedy.
      expect(captions[0]?.props.numberOfLines).toBeUndefined();
      expect(row.props).toMatchObject({
        accessibilityLabel: `${option.label}, ${option.subtitle}, ${disabledReason}`,
        accessibilityRole: "radio",
        accessibilityState: { checked: false, disabled: true },
        disabled: true,
      });
      expect(row.props.accessibilityHint).toBeUndefined();
    },
  );

  it("keeps the selected allowed row selectable without a stale reason", () => {
    const row = ModelRow({ ...rowProps, selected: true });
    expect(row.props).toMatchObject({
      accessibilityLabel: `${option.label}, ${option.subtitle}`,
      accessibilityRole: "radio",
      accessibilityState: { checked: true, disabled: false },
      disabled: false,
      onPress: rowProps.onPress,
    });
    const text = elements(row)
      .map((element) => element.props.children)
      .filter((child) => typeof child === "string");
    expect(text).toContain(option.label);
    expect(text).toContain(option.subtitle);
    expect(text.join(" ")).not.toContain("Start a new thread");
    row.props.onPress();
    expect(rowProps.onPress).toHaveBeenCalledOnce();
  });
});
