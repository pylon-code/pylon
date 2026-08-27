import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ContextCompactionControls,
  ContextWindowMeter,
  HarnessRefinementControls,
} from "./ContextWindowMeter";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ closeDelay, render }: { closeDelay: number; render: ReactNode }) => (
    <div data-close-delay={closeDelay}>{render}</div>
  ),
}));

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

  it("shows progress as soon as a compaction mutation is pending", () => {
    const html = renderToStaticMarkup(
      <ContextCompactionControls
        control={{
          snapshot,
          pendingAction: "compact",
          canCompact: false,
          canAbort: false,
          canSetAuto: false,
          ...handlers,
        }}
      />,
    );

    expect(html).toContain("Starting…");
    expect(html).not.toContain("Ready");
    expect(html).toContain("disabled");
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

describe("ContextWindowMeter hover popover", () => {
  it("lingers while the pointer travels to a control, and closes at once without one", () => {
    const withControls = renderToStaticMarkup(
      <ContextWindowMeter
        usage={null}
        modelDisplayName="Claude"
        timestampFormat="12-hour"
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
    const informational = renderToStaticMarkup(
      <ContextWindowMeter usage={null} modelDisplayName="Claude" timestampFormat="12-hour" />,
    );

    expect(withControls).toContain('data-close-delay="150"');
    expect(informational).toContain('data-close-delay="0"');
  });
});
