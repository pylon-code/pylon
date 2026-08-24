import { describe, expect, it, vi } from "vite-plus/test";

import { applyAppearanceContrast } from "./appearanceContrast";

function makeRoot() {
  const setProperty = vi.fn();
  return {
    root: { style: { setProperty } } as unknown as HTMLElement,
    setProperty,
  };
}

describe("applyAppearanceContrast", () => {
  it("boosts semantic contrast above the default", () => {
    const { root, setProperty } = makeRoot();

    applyAppearanceContrast(root, 135);

    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-base", "100%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-boost", "21%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-border-boost", "8.75%");
  });

  // The foreground mix stops short of the target on purpose: a full 100% makes
  // every foreground role resolve to the target itself, so normal, muted and
  // placeholder text become the same colour at the slider's own maximum.
  it("keeps the maximum foreground boost short of a full mix", () => {
    const { root, setProperty } = makeRoot();

    applyAppearanceContrast(root, 200);

    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-base", "100%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-boost", "60%");
    expect(setProperty).not.toHaveBeenCalledWith("--appearance-contrast-boost", "100%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-border-boost", "25%");
  });

  it("softens semantic contrast below the default", () => {
    const { root, setProperty } = makeRoot();

    applyAppearanceContrast(root, 70);

    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-base", "70%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-boost", "0%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-border-boost", "0%");
  });

  it("disables contrast mixing at the default", () => {
    const { root, setProperty } = makeRoot();

    applyAppearanceContrast(root, 100);

    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-base", "100%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-boost", "0%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-border-boost", "0%");
  });
});
