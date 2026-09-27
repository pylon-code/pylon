import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

/** Serialize native writes and skip superseded snapshots before they start. */
export function createSubscriptionUsagePublisher(
  publish: (snapshot: SubscriptionUsageSnapshot) => Promise<void> | void,
  onError: (error: unknown) => void,
) {
  let queue: Promise<void> = Promise.resolve();
  let latest = 0;
  return (snapshot: SubscriptionUsageSnapshot): Promise<void> => {
    const generation = ++latest;
    queue = queue
      .catch(() => {})
      .then(async () => {
        if (generation !== latest) return;
        await publish(snapshot);
      })
      .catch(onError);
    return queue;
  };
}
