import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { SessionInputQueueSnapshot } from "@t3tools/client-runtime/state/session-input-queue";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  SessionInputQueueControl,
  SessionInputQueueDeliveryPanel,
} from "./SessionInputQueueControl";

const snapshot = {
  provider: ProviderDriverKind.make("primeAgent"),
  providerInstanceId: ProviderInstanceId.make("prime-work"),
  steeringCount: 1,
  followUpCount: 2,
  steeringMode: "all-at-once",
  followUpMode: "one-at-a-time",
  updatedAt: "2026-08-09T00:00:00.000Z",
} satisfies SessionInputQueueSnapshot & {
  readonly steeringMode: "all-at-once";
  readonly followUpMode: "one-at-a-time";
};

const callbacks = {
  onSetMode: () => undefined,
  onClear: () => undefined,
};

describe("SessionInputQueueControl", () => {
  it("renders authoritative delivery state and a bounded clear action", () => {
    const markup = renderToStaticMarkup(
      <SessionInputQueueDeliveryPanel
        snapshot={snapshot}
        count={3}
        canSetModes
        isSettingMode={false}
        canClear
        isClearing={false}
        {...callbacks}
      />,
    );
    expect(markup).toContain('data-session-input-queue-delivery="true"');
    expect(markup).toContain('aria-label="Steering input delivery"');
    expect(markup).toContain('aria-label="Follow-up input delivery"');
    expect(markup).toContain("All at once");
    expect(markup).toContain("One at a time");
    expect(markup).toContain("Clear 3 pending inputs");
    expect(markup).not.toContain("queued prompt");
    expect(markup).not.toContain("activeSessionId");
  });

  it("announces pending changes and disables both selectors", () => {
    const markup = renderToStaticMarkup(
      <SessionInputQueueDeliveryPanel
        snapshot={snapshot}
        count={0}
        canSetModes={false}
        isSettingMode
        canClear={false}
        isClearing={false}
        {...callbacks}
      />,
    );
    expect(markup).toContain("Updating delivery…");
    expect(markup.match(/disabled/g)?.length).toBeGreaterThanOrEqual(2);
    expect(markup).not.toContain("Clear 0");
  });

  it("keeps the closed popover trigger descriptive and compact", () => {
    const markup = renderToStaticMarkup(
      <SessionInputQueueControl
        snapshot={snapshot}
        count={3}
        canSetModes
        isSettingMode={false}
        canClear
        isClearing={false}
        {...callbacks}
      />,
    );
    expect(markup).toContain(
      'aria-label="Session input delivery. 3 pending. Steering all at once. Follow-ups one at a time."',
    );
    expect(markup).toContain("Inputs · 3");
  });
});
