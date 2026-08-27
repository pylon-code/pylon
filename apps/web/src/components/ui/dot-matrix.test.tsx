import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  DotMatrix,
  dotMatrixAnimatedStates,
  dotMatrixStates,
  type DotMatrixState,
} from "./dot-matrix";

const countAnimated = (html: string) => (html.match(/data-animated="true"/g) ?? []).length;
const countChase = (html: string) => (html.match(/data-animated="chase"/g) ?? []).length;

const ASSISTANT_UI_STATES = [
  "idle",
  "loading",
  "thinking",
  "streaming",
  "searching",
  "syncing",
  "connecting",
  "waiting",
  "uploading",
  "downloading",
  "listening",
  "speaking",
  "recording",
  "success",
  "error",
  "warning",
  "info",
  "paused",
  "stopped",
  "offline",
] as const;

describe("DotMatrix", () => {
  it("renders a full 5x5 grid with a status label", () => {
    const html = renderToStaticMarkup(<DotMatrix state="loading" label="Working" />);
    expect((html.match(/<circle/g) ?? []).length).toBe(25);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Working"');
    expect(html).toContain('data-slot="dot-matrix"');
    expect(html).toContain('data-state="loading"');
  });

  it("exports assistant-ui's ordered language plus Pylon's extensions", () => {
    expect(dotMatrixStates).toEqual([
      "idle",
      "loading",
      "orchestrating",
      "queued",
      ...ASSISTANT_UI_STATES.slice(2),
      "terminal",
      "terminal-active",
    ]);
    for (const state of dotMatrixStates) {
      expect(renderToStaticMarkup(<DotMatrix state={state} />)).toContain(`data-state="${state}"`);
    }
  });

  it("uses the expected state-specific animation patterns", () => {
    expect(countAnimated(renderToStaticMarkup(<DotMatrix state="loading" />))).toBe(25);
    expect(countAnimated(renderToStaticMarkup(<DotMatrix state="waiting" />))).toBe(3);
    expect(countAnimated(renderToStaticMarkup(<DotMatrix state="warning" />))).toBe(4);
    expect(countAnimated(renderToStaticMarkup(<DotMatrix state="error" />))).toBe(9);
    expect(countAnimated(renderToStaticMarkup(<DotMatrix state="terminal-active" />))).toBe(8);
    expect(countChase(renderToStaticMarkup(<DotMatrix state="orchestrating" />))).toBe(12);
    expect(dotMatrixAnimatedStates).toContain("terminal-active");
  });

  it("breathes the active terminal glyph in sync", () => {
    const html = renderToStaticMarkup(<DotMatrix state="terminal-active" />);
    expect(html.match(/animation-duration:1.7s/g)).toHaveLength(8);
    expect(html.match(/animation-delay:0s/g)).toHaveLength(8);
  });

  it("gives resting states no animation timeline", () => {
    for (const state of [
      "idle",
      "queued",
      "success",
      "info",
      "paused",
      "stopped",
      "offline",
      "terminal",
    ] as const) {
      const html = renderToStaticMarkup(<DotMatrix state={state} />);
      expect(html).not.toContain("animation-duration");
      expect(html).not.toContain("data-animated");
    }
  });

  it("renders identical markup across renders", () => {
    const a = renderToStaticMarkup(<DotMatrix state="loading" />);
    const b = renderToStaticMarkup(<DotMatrix state="loading" />);
    expect(a).toBe(b);
  });

  it("never emits a positive animation delay", () => {
    for (const state of dotMatrixStates) {
      const html = renderToStaticMarkup(<DotMatrix state={state} />);
      const delays = [...html.matchAll(/animation-delay:\s*([-\d.]+)s/g)].map((match) =>
        Number(match[1]),
      );
      for (const delay of delays) {
        expect(delay, `${state} emitted a positive delay`).toBeLessThanOrEqual(0);
      }
    }
  });

  it("uses adaptive foreground for neutral activity and color for outcomes", () => {
    const toneByState: Record<DotMatrixState, string> = {
      idle: "text-muted-foreground",
      loading: "text-foreground",
      orchestrating: "text-foreground",
      queued: "text-muted-foreground",
      thinking: "text-foreground",
      streaming: "text-foreground",
      searching: "text-foreground",
      syncing: "text-foreground",
      connecting: "text-foreground",
      waiting: "text-foreground",
      uploading: "text-foreground",
      downloading: "text-foreground",
      listening: "text-foreground",
      speaking: "text-foreground",
      recording: "text-destructive",
      success: "text-success",
      error: "text-destructive",
      warning: "text-warning",
      info: "text-primary",
      paused: "text-muted-foreground",
      stopped: "text-muted-foreground",
      offline: "text-muted-foreground",
      terminal: "text-muted-foreground",
      "terminal-active": "text-foreground",
    };
    for (const [state, tone] of Object.entries(toneByState) as [DotMatrixState, string][]) {
      const html = renderToStaticMarkup(<DotMatrix state={state} />);
      const rootTag = html.slice(0, html.indexOf(">") + 1);
      expect(rootTag, `${state} should carry ${tone}`).toContain(tone);
    }
  });

  it("is decorative unless a caller provides a label", () => {
    const html = renderToStaticMarkup(<DotMatrix state="loading" />);
    const rootTag = html.slice(0, html.indexOf(">") + 1);
    expect(rootTag).toContain('aria-hidden="true"');
    expect(rootTag).not.toContain('role="status"');
  });

  it("lets callers override the default tone", () => {
    const html = renderToStaticMarkup(<DotMatrix state="loading" className="text-warning" />);
    const rootTag = html.slice(0, html.indexOf(">") + 1);
    expect(rootTag).toContain("text-warning");
    expect(rootTag).not.toContain("text-foreground");
  });

  it("renders a three-dot cursor in Pylon's terminal glyph", () => {
    const html = renderToStaticMarkup(<DotMatrix state="terminal" />);
    for (const cx of ["10", "14", "18"]) {
      expect(html).toContain(`cx="${cx}" cy="18"`);
    }
  });
});
