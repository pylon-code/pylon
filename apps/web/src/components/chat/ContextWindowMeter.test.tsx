import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ContextCompactionControls,
  ContextWindowMeter,
  HarnessRefinementControls,
} from "./ContextWindowMeter";

const snapshot = {
  available: true,
  status: "idle" as const,
  abortable: false,
  autoCompactionEnabled: true,
  autoCompactionWritable: true,
  manualCompactionSettable: true,
  autoCompactionScope: "session-and-provider-default" as const,
};

const handlers = {
  onCompact: () => undefined,
  onAbort: () => undefined,
  onSetAuto: () => undefined,
};

describe("ContextWindowMeter compaction controls", () => {
  it("keeps a discoverable trigger and controls when post-compaction usage is unknown", () => {
    const trigger = renderToStaticMarkup(
      <ContextWindowMeter
        usage={null}
        timestampFormat="locale"
        compaction={{
          snapshot,
          pendingAction: null,
          canCompact: true,
          canAbort: false,
          canSetAuto: true,
          ...handlers,
        }}
      />,
    );
    const controls = renderToStaticMarkup(
      <ContextCompactionControls
        control={{
          snapshot,
          pendingAction: null,
          canCompact: true,
          canAbort: false,
          canSetAuto: true,
          ...handlers,
        }}
      />,
    );
    expect(trigger).toContain("Context window and compaction controls");
    expect(controls).toContain("Compact now");
    expect(controls).toContain("Automatic compaction");
    expect(controls).toContain("provider&#x27;s default");
  });

  it("renders the reverse action only while native compaction is active", () => {
    const html = renderToStaticMarkup(
      <ContextCompactionControls
        control={{
          snapshot: {
            ...snapshot,
            status: "compacting",
            abortable: true,
            manualCompactionSettable: false,
          },
          pendingAction: null,
          canCompact: false,
          canAbort: true,
          canSetAuto: true,
          ...handlers,
        }}
      />,
    );
    expect(html).toContain("Compacting…");
    expect(html).toContain("Stop compaction");
    expect(html).not.toContain("Compact now");
  });
});

describe("ContextWindowMeter local harness refinement", () => {
  it("renders an accessible, privacy-scoped action without native details", () => {
    const trigger = renderToStaticMarkup(
      <ContextWindowMeter
        usage={null}
        timestampFormat="locale"
        harnessRefinement={{
          pending: false,
          outcomeUnknown: false,
          canRefine: true,
          onRefine: () => undefined,
        }}
      />,
    );
    const controls = renderToStaticMarkup(
      <HarnessRefinementControls
        control={{
          pending: false,
          outcomeUnknown: false,
          canRefine: true,
          onRefine: () => undefined,
        }}
      />,
    );

    expect(trigger).toContain("Context window and harness controls");
    expect(controls).toContain("Refine local harness");
    expect(controls).toContain("only this thread&#x27;s private session harness");
    expect(controls).toContain("may take time");
    expect(controls).toContain("cannot be cancelled or rolled back here");
    const descriptionId = controls.match(/<p id="([^"]+)"/)?.[1];
    expect(descriptionId).toBeDefined();
    expect(controls).toContain(`aria-describedby="${descriptionId}"`);
    expect(controls).not.toMatch(/textarea|path|identifier|rollback button/i);
  });

  it("exposes a single disabled pending action", () => {
    const controls = renderToStaticMarkup(
      <HarnessRefinementControls
        control={{
          pending: true,
          outcomeUnknown: false,
          canRefine: true,
          onRefine: () => undefined,
        }}
      />,
    );

    expect(controls).toContain("Refining…");
    expect(controls).toContain("disabled");
    expect(controls.match(/<button/g)).toHaveLength(1);
    expect(controls).not.toContain("Refine local harness");
  });
});
