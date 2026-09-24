import { describe, expect, it } from "vite-plus/test";
import { composerEnterBehaviorAvailable } from "./composerEnterBehavior";

describe("hardware keyboard Return preference", () => {
  it("offers the control only where the native editor implements it", () => {
    expect(composerEnterBehaviorAvailable("ios")).toBe(true);
    expect(composerEnterBehaviorAvailable("android")).toBe(false);
    expect(composerEnterBehaviorAvailable("web")).toBe(false);
  });
});
