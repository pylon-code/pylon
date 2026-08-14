import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSessionInputQueueMenuActions,
  parseSessionInputQueueModeAction,
} from "./sessionInputQueueMenu";

const snapshot = {
  provider: ProviderDriverKind.make("primeAgent"),
  providerInstanceId: ProviderInstanceId.make("prime-work"),
  steeringCount: 1,
  followUpCount: 2,
  steeringMode: "all-at-once" as const,
  followUpMode: "one-at-a-time" as const,
  updatedAt: "2026-08-09T00:00:00.000Z",
} as const;

describe("session input queue menu", () => {
  it("shows both authoritative modes and a reverse clear action", () => {
    const actions = buildSessionInputQueueMenuActions({
      snapshot,
      count: 3,
      canSetModes: true,
      canClear: true,
      mutating: false,
    });
    expect(actions[0]).toMatchObject({ title: "Steering inputs", subtitle: "All at once" });
    expect(actions[1]).toMatchObject({ title: "Follow-up inputs", subtitle: "One at a time" });
    expect(actions[0]?.subactions).toContainEqual(
      expect.objectContaining({ id: "session-input-mode:steering:all-at-once", state: "on" }),
    );
    expect(actions[2]).toMatchObject({
      id: "session-input-clear",
      title: "Clear 3 pending inputs",
      attributes: { destructive: true },
    });
    expect(JSON.stringify(actions)).not.toContain("queued text");
  });

  it("disables mutations and strictly parses only known mode actions", () => {
    const actions = buildSessionInputQueueMenuActions({
      snapshot,
      count: 0,
      canSetModes: false,
      canClear: false,
      mutating: true,
    });
    expect(actions).toHaveLength(2);
    expect(actions[0]?.subactions?.every((action) => action.attributes?.disabled)).toBe(true);
    expect(parseSessionInputQueueModeAction("session-input-mode:follow-up:all-at-once")).toEqual({
      queue: "follow-up",
      mode: "all-at-once",
    });
    expect(
      parseSessionInputQueueModeAction("session-input-mode:follow-up:native-secret"),
    ).toBeNull();
  });
});
