import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSessionCompactionMenuActions,
  parseSessionCompactionMenuAction,
  sessionCompactionMenuActionId,
} from "./sessionCompactionMenu";

const snapshot = {
  provider: ProviderDriverKind.make("provider-driver"),
  providerInstanceId: ProviderInstanceId.make("work-account"),
  available: true,
  status: "idle" as const,
  abortable: false,
  autoCompactionEnabled: true,
  autoCompactionWritable: true,
  manualCompactionSettable: true,
  autoCompactionScope: "session-and-provider-default" as const,
  updatedAt: "2026-08-09T00:00:00.000Z",
};

describe("session compaction menu", () => {
  it("builds provider-neutral, scope-specific actions with automatic scope disclosure", () => {
    const actions = buildSessionCompactionMenuActions({
      scopeKey: "environment:thread:work-account",
      snapshot,
      canCompact: true,
      canAbort: false,
      canSetAuto: true,
      pendingAction: null,
    });
    expect(actions[0]).toMatchObject({ title: "Compact context now" });
    expect(actions[1]).toMatchObject({
      title: "Automatic compaction",
      subtitle: expect.stringContaining("this session and the provider default"),
    });
    const automatic = actions.find((action) => "subactions" in action);
    expect(automatic && "subactions" in automatic ? automatic.subactions : []).toContainEqual(
      expect.objectContaining({ title: "On", state: "on" }),
    );
    expect(JSON.stringify(actions)).not.toMatch(/prime|codex|claude/i);
  });

  it("strictly parses only the current scope and disables actions while pending", () => {
    const scopeKey = "environment:thread:provider/instance";
    const eventId = sessionCompactionMenuActionId(scopeKey, "auto-disable");
    expect(parseSessionCompactionMenuAction(eventId, scopeKey)).toBe("auto-disable");
    expect(parseSessionCompactionMenuAction(eventId, "other:thread:instance")).toBeNull();
    const actions = buildSessionCompactionMenuActions({
      scopeKey,
      snapshot,
      canCompact: true,
      canAbort: false,
      canSetAuto: true,
      pendingAction: "compact",
    });
    const manual = actions.find((action) => "attributes" in action);
    const automatic = actions.find((action) => "subactions" in action);
    expect(manual && "attributes" in manual ? manual.attributes?.disabled : false).toBe(true);
    expect(
      automatic && "subactions" in automatic
        ? automatic.subactions.every((action) => action.attributes?.disabled)
        : false,
    ).toBe(true);
  });
});
