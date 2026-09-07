import type { CodeViewScrollTarget } from "@pierre/diffs";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useCodeViewFileReveal } from "./useCodeViewFileReveal";

describe("file reveals across lazy viewer mounts", () => {
  let renderer: ReactTestRenderer | undefined;
  const targets: CodeViewScrollTarget[] = [];
  const viewer = {
    getInstance: () => ({}),
    scrollTo: (target: CodeViewScrollTarget) => targets.push(target),
  };

  function Panel({ mounted, scope = "working-tree" }: { mounted: boolean; scope?: string }) {
    const reveal = useCodeViewFileReveal(mounted ? viewer : null, scope);
    return <button onClick={() => reveal("src/app.ts")}>Reveal file</button>;
  }

  beforeEach(() => {
    targets.length = 0;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("reveals once when a viewer mounts after the selection", async () => {
    await act(async () => {
      renderer = create(<Panel mounted={false} />);
    });
    await act(async () => renderer!.root.findByType("button").props.onClick());
    expect(targets).toEqual([]);
    await act(async () => renderer!.update(<Panel mounted />));
    expect(targets).toEqual([{ type: "item", id: "src/app.ts", align: "start" }]);
    await act(async () => renderer!.update(<Panel mounted={false} />));
    await act(async () => renderer!.update(<Panel mounted />));
    expect(targets).toHaveLength(1);
  });

  it("discards a pending selection when the reader changes diff scope", async () => {
    await act(async () => {
      renderer = create(<Panel mounted={false} />);
    });
    await act(async () => renderer!.root.findByType("button").props.onClick());
    await act(async () => renderer!.update(<Panel mounted scope="another-review" />));
    expect(targets).toEqual([]);
    await act(async () => renderer!.root.findByType("button").props.onClick());
    expect(targets).toHaveLength(1);
  });
});
