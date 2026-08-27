import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { dotMatrixStates } from "../ui/dot-matrix";
import { DotMatrixSettings } from "./DotMatrixSettings";
import { dotMatrixSettingsStates } from "./DotMatrixSettings.logic";

describe("DotMatrixSettings", () => {
  it("shows every Dot Matrix state exactly once", () => {
    expect([...dotMatrixSettingsStates].sort()).toEqual([...dotMatrixStates].sort());
    expect(new Set(dotMatrixSettingsStates).size).toBe(dotMatrixStates.length);
  });

  it("does not mount the live catalog until the user opens it", () => {
    const html = renderToStaticMarkup(<DotMatrixSettings />);
    expect(html).toContain("View catalog");
    expect(html).not.toContain('data-slot="dot-matrix"');
    expect(html).not.toContain('id="dot-matrix-status-catalog"');
  });
});
