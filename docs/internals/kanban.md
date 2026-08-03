# Kanban Architecture

> For maintainers. Using T3 Code? See [the Kanban board guide](../user/kanban-board.md).

Kanban is an environment-owned bounded context. It deliberately does not extend the orchestration
read model: loading the chat shell does not transfer board data, provider adapters do not know about
workflow columns, and agent runtime events never move cards.

## Boundary

The typed contract is in [`packages/contracts/src/kanban.ts`][contracts]. Five idempotent mutation
RPCs and one snapshot-plus-events subscription cross the existing authenticated WebSocket. Mutation
methods require orchestration operate access; the subscription uses orchestration read access.

The shared client runtime in [`packages/client-runtime/src/state/kanban.ts`][client] owns stream
reduction and per-environment command scheduling. Web composes that state into the board; another
client can add a native view without changing the transport or server domain.

## Persistence and concurrency

[`KanbanService.ts`][service] serializes mutations per environment. A command checks its durable
`command_id`, validates linked project and thread identities, runs the pure [decider][decider], and
then appends one event plus its projection changes in a single SQLite transaction. Retrying the same
command returns its original result. `expectedRevision` rejects stale edits from another client.

`kanban_events` is the durable fact log and `kanban_work_items` is the read projection. Positions are
scoped to project and status. Archive and restore are explicit reverse operations; there is no
destructive delete operation.

Subscribers attach before reading their snapshot under the mutation semaphore. They therefore see
exactly one initial snapshot followed by every later committed event, without a snapshot/subscribe
gap.

## Integration policy

Keep orchestration, checkpoints, and providers as optional context for a work item, not as ownership
of its lifecycle. A work item may link to a thread and the UI may derive a live work trace from the
generic thread shell. That link is navigational and observational only.

The intentionally narrow upstream touchpoints are contract registration, migration registration,
RPC authorization and handling, the shared runtime export, and web navigation. Feature behavior
stays in the Kanban folders so forks can rebase upstream T3 Code changes without repeatedly merging
through the orchestration core.

[contracts]: ../../packages/contracts/src/kanban.ts
[client]: ../../packages/client-runtime/src/state/kanban.ts
[service]: ../../apps/server/src/kanban/KanbanService.ts
[decider]: ../../apps/server/src/kanban/decider.ts
