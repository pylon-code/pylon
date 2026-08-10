import type { ProviderSessionSideQuestionRequestId, ThreadId } from "@t3tools/contracts";

export interface SessionSideQuestionOwnership {
  readonly register: (threadId: ThreadId, requestId: ProviderSessionSideQuestionRequestId) => void;
  readonly unregister: (
    threadId: ThreadId,
    requestId: ProviderSessionSideQuestionRequestId,
  ) => void;
  readonly owns: (threadId: ThreadId, requestId: ProviderSessionSideQuestionRequestId) => boolean;
  readonly match: <A>(
    threadId: ThreadId,
    requestId: ProviderSessionSideQuestionRequestId,
    handlers: { readonly owned: () => A; readonly unowned: () => A },
  ) => A;
}

/** Per-WebSocket ownership registry. Stores only public request identity and a ref-count. */
export function makeSessionSideQuestionOwnership(): SessionSideQuestionOwnership {
  const requestCountsByThread = new Map<
    ThreadId,
    Map<ProviderSessionSideQuestionRequestId, number>
  >();

  const owns = (threadId: ThreadId, requestId: ProviderSessionSideQuestionRequestId) =>
    requestCountsByThread.get(threadId)?.has(requestId) === true;

  return {
    register(threadId, requestId) {
      const requestCounts = requestCountsByThread.get(threadId) ?? new Map();
      requestCounts.set(requestId, (requestCounts.get(requestId) ?? 0) + 1);
      requestCountsByThread.set(threadId, requestCounts);
    },
    unregister(threadId, requestId) {
      const requestCounts = requestCountsByThread.get(threadId);
      if (requestCounts === undefined) return;
      const remaining = (requestCounts.get(requestId) ?? 1) - 1;
      if (remaining > 0) {
        requestCounts.set(requestId, remaining);
        return;
      }
      requestCounts.delete(requestId);
      if (requestCounts.size === 0) requestCountsByThread.delete(threadId);
    },
    owns,
    match(threadId, requestId, handlers) {
      return owns(threadId, requestId) ? handlers.owned() : handlers.unowned();
    },
  };
}
