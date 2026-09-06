# Live update buffers

Thread subscriptions apply activity payload projection before retaining events in the live buffer. The buffer therefore measures the client payload, rather than the full persisted tool result. A large command log that projects to a short summary does not consume the raw log size from the live-update budget.

Shell subscriptions retain only event type, aggregate kind, aggregate ID, and sequence. Coalescing keeps the latest event per aggregate, then refetches its current shell projection. Message bodies and tool results are not needed to update the sidebar.

Item and byte limits still apply to queued and in-flight projected data. Completion markers remain ordered behind earlier events. A real overflow asks the client to resume from its last received sequence; bounded replay and snapshot recovery remain the same.

The implementation is shared by providers and clients. See `apps/server/src/orchestration/LiveStreamBudget.ts`, `ThreadLiveEventCoalescer.ts` in the same directory, and the subscription handlers in `apps/server/src/ws.ts`. Persisted events retain their original payloads.
