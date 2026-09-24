import { describe, expect, it, vi } from "vite-plus/test";

import { createSubscriptionUsagePublisher } from "./subscriptionUsagePublisher";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

const snapshot = (checkedAt: number): SubscriptionUsageSnapshot => ({ checkedAt, providers: [] });

describe("subscription usage widget publisher", () => {
  it("keeps a rapid account switch as the final native write", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writes: number[] = [];
    const publish = vi.fn(async (value: SubscriptionUsageSnapshot) => {
      writes.push(value.checkedAt);
      if (value.checkedAt === 1) {
        firstStarted();
        await firstWrite;
      }
    });
    const enqueue = createSubscriptionUsagePublisher(publish, () => {});
    const first = enqueue(snapshot(1));
    await started;
    const superseded = enqueue(snapshot(2));
    const signedOut = enqueue(snapshot(0));
    releaseFirst();
    await Promise.all([first, superseded, signedOut]);
    expect(writes).toEqual([1, 0]);
  });

  it("continues after a native write failure so logout can clear old data", async () => {
    const onError = vi.fn();
    const writes: number[] = [];
    const enqueue = createSubscriptionUsagePublisher(async (value) => {
      writes.push(value.checkedAt);
      if (value.checkedAt === 1) throw new Error("native write failed");
    }, onError);
    await enqueue(snapshot(1));
    await enqueue(snapshot(0));
    expect(writes).toEqual([1, 0]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
