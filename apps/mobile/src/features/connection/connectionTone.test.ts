import { describe, expect, it } from "vite-plus/test";

import type { RemoteClientConnectionState } from "../../lib/connection";
import { connectionTone } from "./connectionTone";

const STATES: ReadonlyArray<RemoteClientConnectionState> = [
  "available",
  "connecting",
  "connected",
  "reconnecting",
  "offline",
  "error",
  "unsupported",
];

// Status hues are a fixed cross-client vocabulary (docs/user/status-indicators.md);
// hued theme roles such as `update`, `primary` and `focus` change with the selected theme.
const THEME_DEPENDENT_TOKEN = /(^|-)(update|primary|focus)(-|$)/u;

describe("connectionTone", () => {
  it("keeps Connecting on the fixed sky status hue", () => {
    expect(connectionTone("connecting")).toEqual({
      label: "Connecting",
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-700-300",
    });
  });

  it.each(STATES)("does not let the %s tone follow the theme palette", (state) => {
    const tone = connectionTone(state);
    expect(tone.pillClassName).not.toMatch(THEME_DEPENDENT_TOKEN);
    expect(tone.textClassName).not.toMatch(THEME_DEPENDENT_TOKEN);
  });
});
