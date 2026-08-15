import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SessionResourceList } from "./SessionResourcesDialog";

describe("SessionResourceList", () => {
  it("renders plain bounded metadata and requires an explicit step for more rows", () => {
    const items = Array.from({ length: 61 }, (_, index) => ({
      name: `resource-${index}`,
      description: index === 0 ? "<script>private path is not executable</script>" : undefined,
      argumentHint: index === 0 ? "<version>" : undefined,
      scope: index === 0 ? ("project" as const) : undefined,
    }));

    const html = renderToStaticMarkup(
      <SessionResourceList
        items={items}
        emptyLabel="No resources"
        visibleCount={50}
        onShowMore={vi.fn()}
      />,
    );

    expect(html).toContain("resource-0");
    expect(html).toContain("resource-49");
    expect(html).not.toContain("resource-50");
    expect(html).toContain("Show 11 more");
    expect(html).toContain("&lt;script&gt;private path is not executable&lt;/script&gt;");
    expect(html).toContain("&lt;version&gt;");
    expect(html).toContain("project");
  });

  it("renders an authoritative empty state", () => {
    const html = renderToStaticMarkup(
      <SessionResourceList
        items={[]}
        emptyLabel="No skills available for this session."
        visibleCount={50}
        onShowMore={vi.fn()}
      />,
    );

    expect(html).toContain("No skills available for this session.");
  });
});
