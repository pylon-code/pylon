import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SkillInlineText } from "./SkillInlineText";

describe("SkillInlineText", () => {
  it("copies the original currency alias, including an astral prefix", () => {
    const html = renderToStaticMarkup(
      <SkillInlineText
        text="Use €review then 𑿝review pay €20"
        skills={[{ name: "review" }]}
      />,
    );
    expect(html).toContain('data-markdown-copy="€review"');
    expect(html).toContain('data-markdown-copy="𑿝review"');
    expect(html).not.toContain('data-markdown-copy="€20"');
    expect(html).toContain("pay €20");
  });
});
