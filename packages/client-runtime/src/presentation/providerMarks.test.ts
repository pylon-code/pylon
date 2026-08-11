import { describe, expect, it } from "vite-plus/test";

import { JCODE_MARK_DOTS, JCODE_MARK_VIEW_BOX } from "./providerMarks.js";

describe("Jcode static provider mark geometry", () => {
  it("builds three coarse halftone lobes on a 24px canvas", () => {
    expect(JCODE_MARK_VIEW_BOX).toBe("0 0 24 24");
    expect(JCODE_MARK_DOTS).toHaveLength(54);

    for (const [cx, cy, radius, opacity] of JCODE_MARK_DOTS) {
      expect(cx - radius).toBeGreaterThanOrEqual(0);
      expect(cy - radius).toBeGreaterThanOrEqual(0);
      expect(cx + radius).toBeLessThanOrEqual(24);
      expect(cy + radius).toBeLessThanOrEqual(24);
      expect(opacity).toBeGreaterThanOrEqual(0.6);
      expect(opacity).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the center open and preserves visible dot hierarchy", () => {
    const nearestEdgeToCenter = Math.min(
      ...JCODE_MARK_DOTS.map(([cx, cy, radius]) => Math.hypot(cx - 12, cy - 12) - radius),
    );
    const radii = new Set(JCODE_MARK_DOTS.map(([, , radius]) => radius));
    const opacities = new Set(JCODE_MARK_DOTS.map(([, , , opacity]) => opacity));

    expect(nearestEdgeToCenter).toBeGreaterThan(3.25);
    expect(radii.size).toBeGreaterThanOrEqual(5);
    expect(opacities.size).toBeGreaterThanOrEqual(4);
  });
});
