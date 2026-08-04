import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DotMatrix } from "./dot-matrix";

const countAnimated = (html: string) => (html.match(/data-animated="true"/g) ?? []).length;
const countChase = (html: string) => (html.match(/data-animated="chase"/g) ?? []).length;

describe("DotMatrix", () => {
  it("renders a full 5x5 grid with a status label", () => {
    const html = renderToStaticMarkup(<DotMatrix state="working" label="Working" />);
    expect((html.match(/<circle/g) ?? []).length).toBe(25);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Working"');
    expect(html).toContain('data-state="working"');
  });

  it("animates every dot in working and none in done", () => {
    expect(countAnimated(renderToStaticMarkup(<DotMatrix state="working" />))).toBe(25);
    expect(countAnimated(renderToStaticMarkup(<DotMatrix state="done" />))).toBe(0);
  });

  it("animates only glyph dots in blinking glyph states", () => {
    // BANG glyph has 4 dots, CROSS has 9.
    expect(countAnimated(renderToStaticMarkup(<DotMatrix state="approval" />))).toBe(4);
    expect(countAnimated(renderToStaticMarkup(<DotMatrix state="error" />))).toBe(9);
  });

  it("gives static states no animation timeline at all", () => {
    for (const state of ["plan", "done", "idle"] as const) {
      const html = renderToStaticMarkup(<DotMatrix state={state} />);
      expect(html).not.toContain("animation-duration");
      expect(html).not.toContain('data-animated="true"');
    }
  });

  it("renders identical markup across renders (deterministic hash)", () => {
    const a = renderToStaticMarkup(<DotMatrix state="working" />);
    const b = renderToStaticMarkup(<DotMatrix state="working" />);
    expect(a).toBe(b);
  });

  it("falls back to the state name as the accessible label", () => {
    expect(renderToStaticMarkup(<DotMatrix state="connecting" />)).toContain(
      'aria-label="connecting"',
    );
  });

  it("animates only the ring dots in spinner, using the chase keyframe", () => {
    const html = renderToStaticMarkup(<DotMatrix state="spinner" />);
    // RING glyph has 12 dots (perimeter minus corners); the 4 corners plus 9
    // interior dots must stay unanimated.
    expect(countAnimated(html)).toBe(0);
    expect(countChase(html)).toBe(12);
    const corners = ['cx="2" cy="2"', 'cx="18" cy="2"', 'cx="2" cy="18"', 'cx="18" cy="18"'];
    for (const corner of corners) {
      const cornerCircle = html.split("<circle").find((c) => c.includes(corner));
      expect(cornerCircle).toBeDefined();
      expect(cornerCircle).not.toContain("data-animated");
    }
  });

  it("never emits a positive animation-delay (unsigned hash regression)", () => {
    const html = renderToStaticMarkup(<DotMatrix state="working" />);
    const delays = [...html.matchAll(/animation-delay:\s*([-\d.]+)s/g)].map((m) => Number(m[1]));
    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(0);
    }
  });

  it("applies each state's canonical tone by default", () => {
    const toneByState: Record<string, string> = {
      working: "text-primary",
      connecting: "text-primary",
      spinner: "text-primary",
      done: "text-success",
      live: "text-success",
      error: "text-destructive",
      recording: "text-destructive",
      approval: "text-warning",
      input: "text-warning",
      idle: "text-muted-foreground",
      terminal: "text-muted-foreground",
      plan: "text-muted-foreground",
    };
    for (const [state, tone] of Object.entries(toneByState)) {
      const html = renderToStaticMarkup(<DotMatrix state={state as keyof typeof toneByState} />);
      const rootTag = html.slice(0, html.indexOf(">") + 1);
      expect(rootTag, `${state} should carry ${tone}`).toContain(tone);
    }
  });

  it("lets a caller override the default tone via className (twMerge keeps the override)", () => {
    const html = renderToStaticMarkup(<DotMatrix state="working" className="text-foreground" />);
    const rootTag = html.slice(0, html.indexOf(">") + 1);
    expect(rootTag).toContain("text-foreground");
    expect(rootTag).not.toContain("text-primary");
  });
});
