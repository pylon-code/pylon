// Shared across hook instances so sidebar, header and menu actions invalidate each other.
interface ActionClaim {
  readonly sessionOwner: object | null;
  readonly isCurrent: () => boolean;
  readonly finish: () => void;
  readonly offerToBatch: (receiptSequence: number) => void;
}

const currentActions = new Map<
  string,
  { threadKey: string; token: symbol; claim: ActionClaim; batchReceiptSequence: number | null }
>();
export interface ActionProjection {
  readonly owner: object;
  readonly generation: number;
  readonly sequence: number;
}

function sameOwner(a: ActionProjection | null, b: ActionProjection | null): boolean {
  return a !== null && b !== null && a.owner === b.owner && a.generation === b.generation;
}

const observedResults = new Map<
  string,
  {
    threadKey: string;
    projection: ActionProjection | null;
    intent: string;
    inFlight: boolean;
    receiptSequence: number | null;
    stopWatching: (() => void) | null;
    result: Promise<{ readonly _tag: string }>;
  }
>();

/** Claims a thread action; any later lifecycle action on that thread expires its Undo. */
export function begin(
  kind: string,
  threadKey: string,
  owner?: {
    readonly projection: ActionProjection | null;
    readonly read: () => ActionProjection | null;
  },
) {
  invalidateThread(threadKey);
  const key = JSON.stringify([kind, threadKey]);
  const token = Symbol();
  const isCurrent = () =>
    currentActions.get(key)?.token === token &&
    (owner === undefined || sameOwner(owner.projection, owner.read()));
  const claim = {
    sessionOwner: owner?.projection?.owner ?? null,
    isCurrent,
    finish: () => {
      if (currentActions.get(key)?.token === token) currentActions.delete(key);
    },
    offerToBatch: (receiptSequence: number) => {
      const current = currentActions.get(key);
      if (isCurrent() && current) current.batchReceiptSequence = receiptSequence;
    },
  };
  currentActions.set(key, { threadKey, token, claim, batchReceiptSequence: null });
  return claim;
}

/** Transfer a confirmed silent action's claim to one aggregate toast. */
export function takeBatchClaim(
  kind: string,
  threadKey: string,
  receiptSequence: number,
): ActionClaim | null {
  const action = currentActions.get(JSON.stringify([kind, threadKey]));
  if (action?.batchReceiptSequence !== receiptSequence || !action.claim.isCurrent()) return null;
  action.batchReceiptSequence = null;
  return action.claim;
}

/** Join an intent until its receipt has reached this connection's live shell. */
export function runOnce<T extends { readonly _tag: string }>(
  kind: string,
  threadKey: string,
  intent: string,
  readProjection: () => ActionProjection | null,
  watchProjection: (onChange: () => void) => () => void,
  receiptSequence: (result: T) => number | null,
  run: (claim: ReturnType<typeof begin>) => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([kind, threadKey]);
  const projection = readProjection();
  const existing = observedResults.get(key);
  if (
    existing?.intent === intent &&
    sameOwner(existing.projection, projection) &&
    (existing.inFlight ||
      existing.receiptSequence === null ||
      (projection !== null && projection.sequence < existing.receiptSequence))
  ) {
    return existing.result as Promise<T>;
  }
  const claim = begin(kind, threadKey, { projection, read: readProjection });
  const result = run(claim);
  const outcome = {
    threadKey,
    projection,
    intent,
    inFlight: true,
    receiptSequence: null as number | null,
    stopWatching: null as (() => void) | null,
    result,
  };
  observedResults.set(key, outcome);
  const forget = () => {
    outcome.stopWatching?.();
    outcome.stopWatching = null;
    if (observedResults.get(key)?.result === result) observedResults.delete(key);
  };
  const checkProjection = () => {
    const current = readProjection();
    if (!sameOwner(projection, current)) {
      claim.finish();
      forget();
    } else if (
      !outcome.inFlight &&
      outcome.receiptSequence !== null &&
      current !== null &&
      current.sequence >= outcome.receiptSequence
    ) {
      forget();
    }
  };
  outcome.stopWatching = watchProjection(checkProjection);
  checkProjection();
  void result.then(
    (receipt) => {
      outcome.inFlight = false;
      if (receipt._tag !== "Success") {
        forget();
      } else {
        outcome.receiptSequence = receiptSequence(receipt);
        checkProjection();
      }
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
  observedResults.get(key)?.stopWatching?.();
  observedResults.delete(key);
}

/** A new lifecycle intent or deletion makes every older inverse unsafe. */
export function invalidateThread(threadKey: string) {
  for (const [key, action] of currentActions) {
    if (action.threadKey === threadKey) currentActions.delete(key);
  }
  for (const [key, outcome] of observedResults) {
    if (outcome.threadKey === threadKey) {
      outcome.stopWatching?.();
      observedResults.delete(key);
    }
  }
}
