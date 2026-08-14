import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveReportedTurnCosts, formatReportedTurnCost } from "./turnCosts.ts";

function activity(input: {
  id: string;
  turnId: string | null;
  value: unknown;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    createdAt: "2026-08-09T00:00:00.000Z",
    tone: "info",
    kind: "turn.cost",
    summary: "Reported turn cost",
    payload: { totalCostUsd: input.value },
    turnId: input.turnId === null ? null : TurnId.make(input.turnId),
  };
}

describe("reported turn costs", () => {
  it("derives valid per-turn values, preserving zero and latest replacement", () => {
    const costs = deriveReportedTurnCosts([
      activity({ id: "one-old", turnId: "turn-1", value: 0.2 }),
      activity({ id: "one-new", turnId: "turn-1", value: 0.25 }),
      activity({ id: "zero", turnId: "turn-zero", value: 0 }),
      activity({ id: "negative", turnId: "turn-negative", value: -1 }),
      activity({ id: "nan", turnId: "turn-nan", value: Number.NaN }),
      activity({ id: "turnless", turnId: null, value: 1 }),
    ]);
    expect([...costs]).toEqual([
      ["turn-1", 0.25],
      ["turn-zero", 0],
    ]);
  });

  it("formats reported estimates without rounding tiny values to zero", () => {
    expect(formatReportedTurnCost(0)).toBe("Reported cost $0.0000");
    expect(formatReportedTurnCost(0.0004)).toBe("Reported cost <$0.01");
    expect(formatReportedTurnCost(0.123456)).toBe("Reported cost $0.1235");
    expect(formatReportedTurnCost(12.3456)).toBe("Reported cost $12.346");
    expect(formatReportedTurnCost(123.456)).toBe("Reported cost $123.46");
    expect(formatReportedTurnCost(-1)).toBeNull();
  });
});
