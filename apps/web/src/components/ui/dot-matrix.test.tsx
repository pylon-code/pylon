import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DotMatrix } from "./dot-matrix";

const countAnimated = (html: string) => (html.match(/data-animated="true"/g) ?? []).length;

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

  it("never emits a positive animation-delay (unsigned hash regression)", () => {
    const html = renderToStaticMarkup(<DotMatrix state="working" />);
    const delays = [...html.matchAll(/animation-delay:\s*([-\d.]+)s/g)].map((m) => Number(m[1]));
    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(0);
    }
  });
});
