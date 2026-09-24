// Shared across hook instances so sidebar, header and menu actions invalidate each other.
const currentActions = new Map<string, { threadKey: string; token: symbol }>();
const observedResults = new Map<
  string,
  {
    threadKey: string;
    observed: object;
    intent: string;
    inFlight: boolean;
    result: Promise<{ readonly _tag: string }>;
  }
>();

/** Claims a thread action; any later lifecycle action on that thread expires its Undo. */
export function begin(kind: string, threadKey: string) {
  invalidateThread(threadKey);
  const key = JSON.stringify([kind, threadKey]);
  const token = Symbol();
  currentActions.set(key, { threadKey, token });
  const isCurrent = () => currentActions.get(key)?.token === token;
  return {
    isCurrent,
    finish: () => {
      if (isCurrent()) currentActions.delete(key);
    },
  };
}

/** Join one in-flight intent, then dedupe only while its projected shell is unchanged. */
export function runOnce<T extends { readonly _tag: string }>(
  kind: string,
  threadKey: string,
  observed: object,
  intent: string,
  run: (claim: ReturnType<typeof begin>) => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([kind, threadKey]);
  const existing = observedResults.get(key);
  // An unrelated projection may replace the shell before this receipt settles.
  if (existing?.intent === intent && (existing.inFlight || existing.observed === observed)) {
    // Follow the latest unrelated shell projection while the receipt is
    // pending, so projection lag after receipt still joins this outcome.
    if (existing.inFlight) existing.observed = observed;
    return existing.result as Promise<T>;
  }
  const claim = begin(kind, threadKey);
  const result = run(claim);
  const outcome = { threadKey, observed, intent, inFlight: true, result };
  observedResults.set(key, outcome);
  const forget = () => {
    if (observedResults.get(key)?.result === result) observedResults.delete(key);
  };
  void result.then(
    (receipt) => {
      outcome.inFlight = false;
      if (receipt._tag !== "Success") forget();
    },
    () => {
      outcome.inFlight = false;
      forget();
    },
  );
  return result;
}

/** Expires one action kind; use invalidateThread for lifecycle changes. */
export function invalidate(kind: string, threadKey: string) {
  const key = JSON.stringify([kind, threadKey]);
  currentActions.delete(key);
  observedResults.delete(key);
}

/** A new lifecycle intent or deletion makes every older inverse unsafe. */
export function invalidateThread(threadKey: string) {
  for (const [key, action] of currentActions) {
    if (action.threadKey === threadKey) currentActions.delete(key);
  }
  for (const [key, outcome] of observedResults) {
    if (outcome.threadKey === threadKey) observedResults.delete(key);
  }
}
