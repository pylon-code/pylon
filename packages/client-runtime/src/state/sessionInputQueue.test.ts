import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  deriveLatestSessionInputQueue,
  sessionInputQueueCount,
  supportsSessionInputQueueClear,
  supportsSessionInputQueueFollowUp,
} from "./sessionInputQueue.ts";

const activity = (input: {
  readonly id: string;
  readonly providerInstanceId: string;
  readonly steeringCount: number;
  readonly followUpCount: number;
}): OrchestrationThreadActivity =>
  ({
    id: input.id,
    kind: "session.input-queue.updated",
    tone: "info",
    summary: "Session input queue updated",
    turnId: null,
    payload: {
      provider: "primeAgent",
      providerInstanceId: input.providerInstanceId,
      steeringCount: input.steeringCount,
      followUpCount: input.followUpCount,
    },
    createdAt: `2026-08-09T00:00:0${input.id}.000Z`,
  }) as OrchestrationThreadActivity;

describe("session input queue state", () => {
  it("derives only the active provider instance snapshot", () => {
    const snapshot = deriveLatestSessionInputQueue(
      [
        activity({ id: "1", providerInstanceId: "prime-work", steeringCount: 1, followUpCount: 2 }),
        activity({
          id: "2",
          providerInstanceId: "prime-other",
          steeringCount: 8,
          followUpCount: 8,
        }),
        activity({ id: "3", providerInstanceId: "prime-work", steeringCount: 0, followUpCount: 4 }),
      ],
      ProviderInstanceId.make("prime-work"),
    );
    expect(snapshot?.steeringCount).toBe(0);
    expect(snapshot?.followUpCount).toBe(4);
    expect(sessionInputQueueCount(snapshot)).toBe(4);
  });

  it("gates writes on explicitly advertised operations", () => {
    const provider = {
      featureCapabilities: {
        version: 1 as const,
        inputQueue: {
          support: "read-write" as const,
          operations: ["observe" as const, "follow-up" as const, "clear" as const],
        },
      },
    };
    expect(supportsSessionInputQueueFollowUp(provider)).toBe(true);
    expect(supportsSessionInputQueueClear(provider)).toBe(true);
    expect(supportsSessionInputQueueClear(null)).toBe(false);
  });
});
