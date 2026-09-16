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

Caveat: a client acting for the same user could create a thread with a delegated id first; the
toolkit then treats it as an existing child. Nothing crosses a user boundary.

## Idempotency and cleanup

Every dispatched command has a deterministic id, so the receipt store absorbs retries. A child that
exists but never received its first message is a half-built attempt from a crash or restart; the
next call with that key discards it. Any failure or interruption after `thread.create` removes the
child's worktree and deletes the thread. The worktree path and the created flag are recorded inside
the uninterruptible steps that create them, so cleanup cannot miss a resource that exists. After
cleanup the key is consumed for good: replaying an accepted create onto a missing thread, or a
rejected receipt, reports a consumed key rather than resurrecting the attempt.

Thread deletion itself never removes worktrees (the web client does that), which is why the toolkit
removes them explicitly.

## Accepted limits

- A follow-up is refused while the child is running, but a user message can arrive between the
  check and the dispatch; the follow-up then steers that turn, as any turn start on a running turn
  does. Not guarded.
- The per-parent semaphore that serializes delegation is in memory, which is enough because one
  server process owns the orchestration engine.
- Waiting is bounded polling of the projection inside the tool call. Pylon disables Prime's
  autonomous continuation, so a parent cannot be woken when a child finishes.
- Worktree creation mirrors the websocket bootstrap sequence without sharing code with `ws.ts`, and
  does not run project setup scripts. Changes to how clients create worktrees must be checked here.
