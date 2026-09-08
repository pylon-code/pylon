import * as NodeURL from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";

// Resolve Uniwind's internal aliases to the installed package, not the app.
vi.mock("@/common/consts", () => import("../../node_modules/uniwind/src/common/consts"));
vi.mock("@/common/utils", () => import("../../node_modules/uniwind/src/common/utils"));

async function compile(css: string) {
  const path = NodeURL.fileURLToPath(
    new URL("../../node_modules/uniwind/src/bundler/css-processor/processor.ts", import.meta.url),
  );
  const { ProcessorBuilder } = (await import(/* @vite-ignore */ path)) as {
    ProcessorBuilder: new (config: { themes: string[] }) => {
      transform(css: string): void;
      stylesheets: Record<string, Array<Record<string, unknown>>>;
    };
  };
  const processor = new ProcessorBuilder({ themes: ["light", "dark"] });
  processor.transform(css);
  return processor.stylesheets;
}

describe("Uniwind conditional selectors", () => {
  it.each(["active", "focus", "disabled"])(
    "preserves %s conditions in nested and flat Tailwind output",
    async (variant) => {
      const nested = await compile(`.utility { &:${variant} { opacity: 0.7; } }`);
      const flat = await compile(`.utility:${variant} { opacity: 0.7; }`);
      expect(flat.utility).toEqual(nested.utility);
      expect(flat.utility?.at(-1)?.[variant]).toBe(true);
      expect(flat.utility?.at(-1)?.opacity).toBeCloseTo(0.7);
    },
  );

  it("keeps ordinary utilities unconditional and drops unsupported conditions", async () => {
    const styles = await compile(
      '.plain { opacity: 1; } .unsupported[aria-disabled="true"] { opacity: 0.5; }',
    );
    expect(styles.plain?.at(-1)).toMatchObject({ opacity: 1, active: null, disabled: null });
    expect(styles.unsupported?.some((style) => "opacity" in style)).toBe(false);
  });

  it("retains theme, direction and data conditions", async () => {
    const styles = await compile(
      '.theme:where(.dark) { opacity: 0.8; } .direction:where(:dir(rtl)) { opacity: 0.6; } .data[data-selected="yes"] { opacity: 0.4; }',
    );
    expect(styles.theme?.at(-1)).toMatchObject({ theme: "dark" });
    expect(styles.direction?.at(-1)).toMatchObject({ rtl: true });
    expect(styles.data?.at(-1)).toMatchObject({ dataAttributes: { "data-selected": '"yes"' } });
  });
});
