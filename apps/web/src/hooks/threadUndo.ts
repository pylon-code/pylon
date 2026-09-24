// Shared across hook instances so sidebar, header and menu actions invalidate each other.
const currentActions = new Map<string, { threadKey: string; token: symbol }>();
const observedResults = new Map<
  string,
  {
    threadKey: string;
    observed: object;
    intent: string;
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

/** Join callbacks against one projected shell to its real receipt, including failures. */
export function runOnce<T extends { readonly _tag: string }>(
  kind: string,
  threadKey: string,
  observed: object,
  intent: string,
  run: (claim: ReturnType<typeof begin>) => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([kind, threadKey]);
  const existing = observedResults.get(key);
  if (existing?.observed === observed && existing.intent === intent)
    return existing.result as Promise<T>;
  const claim = begin(kind, threadKey);
  const result = run(claim);
  observedResults.set(key, { threadKey, observed, intent, result });
  const forget = () => {
    if (observedResults.get(key)?.result === result) observedResults.delete(key);
  };
  void result.then((receipt) => {
    if (receipt._tag !== "Success") forget();
  }, forget);
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
