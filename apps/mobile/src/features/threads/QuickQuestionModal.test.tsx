// @ts-ignore -- Vitest is provided by the vite-plus test runner.
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Modal: "Modal",
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "request-id" }));
vi.mock("../../components/AppText", () => ({
  AppText: "Text",
  AppTextInput: "TextInput",
}));
vi.mock("../../components/ComposerToolbar", () => ({
  ComposerToolbarButton: "ComposerToolbarButton",
}));

import { QuickQuestionTrigger } from "./QuickQuestionModal";

describe("QuickQuestionTrigger", () => {
  it("exposes the stable accessible toolbar trigger", () => {
    const onPress = vi.fn();
    const element = QuickQuestionTrigger({ onPress });

    expect(element.props).toMatchObject({
      accessibilityLabel: "Quick question",
      label: "Quick question",
      showChevron: false,
      testID: "quick-question-trigger",
      onPress,
    });
  });
});
