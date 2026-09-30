import { describe, expect, it } from "vite-plus/test";

import { resolveAndroidControlSizing } from "./androidControlSizing";

describe("Android control sizing", () => {
  it.each([
    [11, 17, 11, 44, 48, 172, 80],
    [16, 24, 16, 44, 56, 250, 88],
    [22, 33, 22, 61, 77, 344, 109],
  ])(
    "scales controls at %ipt",
    (fontSize, iconSize, smallIconSize, buttonSize, fabSize, menuWidth, fabClearance) => {
      expect(resolveAndroidControlSizing(fontSize)).toMatchObject({
        iconSize,
        smallIconSize,
        buttonSize,
        fabSize,
        menuWidth,
        fabClearance,
      });
    },
  );

  it("leaves the default text size at the unscaled layout", () => {
    expect(resolveAndroidControlSizing(16).scale).toBe(1);
  });
});
