# Delegated threads

The delegation MCP toolkit ([`apps/server/src/mcp/toolkits/delegation`](../../apps/server/src/mcp/toolkits/delegation))
lets an agent start and manage child threads on other provider instances. It is a sidecar: it
dispatches only existing commands (`thread.create`, `thread.meta.update`, `thread.turn.start`,
`thread.turn.interrupt`, `thread.delete`) and reads only existing projections. It adds no events,
decider branches, projectors, or migrations, so it can be removed or remapped if Pylon adopts
upstream's orchestrator rewrite. It deliberately does not reuse upstream's reserved
`delegate_task`, `task_status`, or `task_cancel` tool names.

## The child id carries the parent

A child's thread id is `delegated:<parentThreadId>:<first 16 hex of sha256(parent + "\n" + key)>`.
Ownership (a parent only ever computes ids under its own prefix), depth (the capability is never
minted for a `delegated:` thread, and the handler refuses one), and the live-children count are all
derived from that prefix. They survive restarts without a contract field or a table.
`continuedFromThreadId` shows what a field costs instead: contracts, decider, projector, a
migration, and every client.

Thread ids are otherwise opaque. The one exception was the mobile composer draft key
`${environmentId}:${threadId}`: both halves may contain colons, so the parser now takes the
environment ids its caller already knows instead of splitting on a fixed colon.

Caveat: a client acting for the same user could create a thread with a delegated id first. If that
thread has a session, a turn, or a rollback, the toolkit treats it as an existing child; if it has
none of those, it looks like a crash-orphaned attempt and is deleted. Nothing crosses a user boundary.

## Idempotency and cleanup

Every create, meta update, and turn command has a deterministic id, so the receipt store absorbs
retries. Discards use a unique delete id instead, because a deterministic one would replay as success
without deleting if the same child id were ever created again.

A child counts as a crash-orphaned attempt only when it has no initial message, no session, no turn,
and a source epoch of zero. The initial message alone is not proof: rewinding a child's first message
removes it too, but leaves a session and a later source epoch behind. The next call with an orphan's key
discards it. Any failure or interruption after `thread.create` also removes the child's worktree and
deletes the thread. The worktree path and the created flag are recorded inside the uninterruptible
steps that create them, so cleanup cannot miss a resource that exists. Forced worktree removal is
limited to paths under the server's managed worktrees directory, since a thread can record any path.
After cleanup the key is consumed for good.

Thread deletion itself never removes worktrees (the web client does that), which is why the toolkit
removes them explicitly.

## Child state

A turn start waiting for provider admission changes the session to `starting`, not `latestTurn`. The
state rules therefore check `starting` first, or a follow-up would read as the previous completed turn.
The pending admission id alone is not used: interrupt recovery before the provider binds stops the
session but leaves that id set until the next turn start replaces it. A first turn stopped before admission leaves a
session but no turn and is reported as interrupted, not queued forever.

## Accepted limits

- A follow-up is refused while the child is running, but a user message can arrive between the
  check and the dispatch; the follow-up then steers that turn, as any turn start on a running turn
  does. Not guarded.
- The per-parent semaphore that serializes delegation is in memory, which is enough because one
  server process owns the orchestration engine.
- Waiting is polling of the projection inside the tool call, bounded by wall-clock time to 45
  seconds. Prime Agent's MCP client cancels any call after 60 seconds, measured in a live run.
  Pylon disables Prime's autonomous continuation, so a parent cannot be woken when a child finishes.
- The per-parent semaphores are never evicted; one small entry per thread that has delegated.
- Interrupts use a unique command id per call rather than a deterministic one. Every deterministic
  key tried (per turn, per admission) let a later interrupt replay an earlier receipt and dispatch
  nothing; a duplicate interrupt on a live child is harmless.
- Worktree creation mirrors the websocket bootstrap sequence without sharing code with `ws.ts`, and
  does not run project setup scripts. Changes to how clients create worktrees must be checked here.
