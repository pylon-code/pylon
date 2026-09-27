import { Suspense, act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ComposerAliasPolicy } from "./composer-logic";
import { useComposerAliasPolicyReaders } from "./useComposerAliasPolicyReaders";

let renderer: ReactTestRenderer | undefined;
let readers: ReturnType<typeof useComposerAliasPolicyReaders>;

const pendingRender = new Promise<void>(() => {});

function Harness(props: { policy: ComposerAliasPolicy; suspend?: boolean }) {
  readers = useComposerAliasPolicyReaders(props.policy);
  if (props.suspend) throw pendingRender;
  return null;
}

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("useComposerAliasPolicyReaders", () => {
  it("does not expose a provider policy from a suspended render", async () => {
    const enabled = { allowUnicodeSkillAliases: true, unicodeSkillNames: new Set(["review"]) };
    await act(() => {
      renderer = create(
        createElement(Suspense, { fallback: null }, createElement(Harness, { policy: enabled })),
      );
    });
    const capturedTrigger = readers.detectComposerTrigger;
    expect(capturedTrigger("€review", "€review".length)?.kind).toBe("skill");

    await act(() => {
      renderer?.update(
        createElement(
          Suspense,
          { fallback: null },
          createElement(Harness, {
            policy: { allowUnicodeSkillAliases: false, unicodeSkillNames: new Set(["review"]) },
            suspend: true,
          }),
        ),
      );
    });
    expect(capturedTrigger("€review", "€review".length)?.kind).toBe("skill");
  });

  it("updates captured composer callbacks across provider switches and catalog removal", async () => {
    const prompt = "Use 𑿝review and $review ";
    const render = async (policy: ComposerAliasPolicy) => {
      await act(() => {
        if (renderer) renderer.update(createElement(Harness, { policy }));
        else renderer = create(createElement(Harness, { policy }));
      });
    };

    await render({ allowUnicodeSkillAliases: true, unicodeSkillNames: new Set(["review"]) });
    const capturedCollapse = readers.collapseExpandedComposerCursor;
    const capturedExpand = readers.expandCollapsedComposerCursor;
    const capturedTrigger = readers.detectComposerTrigger;
    const supportedCursor = capturedCollapse(prompt, prompt.length);
    expect(capturedExpand(prompt, supportedCursor)).toBe(prompt.length);
    expect(capturedTrigger("€review", "€review".length)?.kind).toBe("skill");

    await render({ allowUnicodeSkillAliases: false, unicodeSkillNames: new Set(["review"]) });
    expect(readers.collapseExpandedComposerCursor).toBe(capturedCollapse);
    expect(capturedCollapse(prompt, prompt.length)).toBeGreaterThan(supportedCursor);
    expect(capturedExpand(prompt, capturedCollapse(prompt, prompt.length))).toBe(prompt.length);
    expect(capturedTrigger("€review", "€review".length)).toBeNull();

    await render({ allowUnicodeSkillAliases: true, unicodeSkillNames: new Set() });
    expect(capturedCollapse(prompt, prompt.length)).toBeGreaterThan(supportedCursor);
    expect(capturedExpand(prompt, capturedCollapse(prompt, prompt.length))).toBe(prompt.length);

    await render({ allowUnicodeSkillAliases: true, unicodeSkillNames: new Set(["review"]) });
    expect(capturedCollapse(prompt, prompt.length)).toBe(supportedCursor);
  });
});
