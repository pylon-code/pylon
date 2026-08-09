import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ContextCompactionControls, ContextWindowMeter } from "./ContextWindowMeter";

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
