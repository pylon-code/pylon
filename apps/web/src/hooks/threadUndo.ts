// Shared across hook instances so sidebar, header and menu actions invalidate each other.
const currentActions = new Map<string, { threadKey: string; token: symbol }>();

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

/** Expires one action kind; use invalidateThread for lifecycle changes. */
export function invalidate(kind: string, threadKey: string) {
  currentActions.delete(JSON.stringify([kind, threadKey]));
}

/** A new lifecycle intent or deletion makes every older inverse unsafe. */
export function invalidateThread(threadKey: string) {
  for (const [key, action] of currentActions) {
    if (action.threadKey === threadKey) currentActions.delete(key);
  }
}
