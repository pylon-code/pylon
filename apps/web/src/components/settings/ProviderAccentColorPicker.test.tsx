import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: () => null,
  PopoverClose: () => null,
}));

import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function control(label: string) {
  return renderer!.root.find(
    (node) =>
      (node.props.role === "slider" || node.props.type === "range") &&
      node.props["aria-label"] === label,
  );
}

async function press(label: string, key: string, shiftKey = false) {
  const preventDefault = vi.fn();
  await act(async () => control(label).props.onKeyDown({ key, shiftKey, preventDefault }));
  return preventDefault;
}

describe("provider accent color keyboard controls", () => {
  it("adjusts hue and both plane axes through focusable controls without changing unrelated axes", async () => {
    const onCommit = vi.fn();
    await act(async () => {
      renderer = create(
        <ProviderAccentColorPicker displayName="Codex" value="#ff0000" onCommit={onCommit} />,
      );
    });
    const hue = "Accent color hue";
    const saturation = "Accent color saturation";
    const brightness = "Accent color brightness";
    expect(control(hue).props.tabIndex).toBe(0);
    expect(control(saturation).props.type).toBe("range");
    expect(control(brightness).props.type).toBe("range");

    expect(await press(hue, "ArrowLeft")).toHaveBeenCalledOnce();
    expect(control(hue).props["aria-valuenow"]).toBe(359);
    expect(await press(hue, "ArrowRight")).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenLastCalledWith("#ff0000");

    await press(saturation, "ArrowLeft", true);
    expect(control(saturation).props["aria-valuetext"]).toBe("90%");
    expect(control(brightness).props["aria-valuetext"]).toBe("100%");
    expect(onCommit).toHaveBeenLastCalledWith("#ff1919");
    await press(brightness, "ArrowDown", true);
    expect(control(saturation).props["aria-valuetext"]).toBe("90%");
    expect(control(brightness).props["aria-valuetext"]).toBe("90%");
    expect(onCommit).toHaveBeenLastCalledWith("#e61717");
    expect(control(hue).props["aria-valuenow"]).toBe(0);

    onCommit.mockClear();
    expect(await press(saturation, "Tab")).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("supports native range changes and Home/End per color channel", async () => {
    const onCommit = vi.fn();
    await act(async () => {
      renderer = create(
        <ProviderAccentColorPicker displayName="Codex" value="#ff0000" onCommit={onCommit} />,
      );
    });
    const saturation = "Accent color saturation";
    const brightness = "Accent color brightness";
    await press(saturation, "Home");
    expect(control(saturation).props.value).toBe(0);
    expect(onCommit).toHaveBeenLastCalledWith("#ffffff");
    await act(async () =>
      control(brightness).props.onChange({ currentTarget: { valueAsNumber: 50 } }),
    );
    expect(control(brightness).props.value).toBe(50);
    expect(onCommit).toHaveBeenLastCalledWith("#808080");
    await press(saturation, "End");
    expect(control(saturation).props.value).toBe(100);
    await press("Accent color hue", "End");
    expect(control("Accent color hue").props["aria-valuenow"]).toBe(359);
  });
});
