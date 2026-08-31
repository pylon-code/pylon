import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerStashBadge } from "./ComposerStashBadge";

const base = {
  count: 3,
  menuOpen: false,
  pulseKey: 0,
  pulsing: false,
  onToggleMenu: () => undefined,
};

describe("ComposerStashBadge", () => {
  it("renders nothing when the stash is empty", () => {
    expect(renderToStaticMarkup(<ComposerStashBadge {...base} count={0} />)).toBe("");
  });

  it("names the stash and its count for assistive tech", () => {
    const markup = renderToStaticMarkup(<ComposerStashBadge {...base} />);

    expect(markup).toContain('aria-label="Stashed prompts: 3. Open stash."');
    expect(markup).toContain('data-prompt-stash-badge="true"');
    expect(markup).toContain("Stash");
  });

  it("wraps in a glass surface as a shoulder tab", () => {
    const markup = renderToStaticMarkup(<ComposerStashBadge {...base} />);

    expect(markup).toContain("data-composer-shoulder-tab");
  });

  it("drops the glass surface inline so it can sit in a compact toolbar", () => {
    const markup = renderToStaticMarkup(<ComposerStashBadge {...base} placement="inline" />);

    expect(markup).not.toContain("data-composer-shoulder-tab");
    expect(markup).toContain('data-prompt-stash-badge="true"');
  });
});
