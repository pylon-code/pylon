# Follow-ups architecture

> For maintainers. Using Pylon? See the [follow-ups guide](../user/follow-ups.md).

Follow-ups are an environment-owned bounded context. They hold deliberate deferrals: work noticed
but not being done now, plus ideas worth retaining. They deliberately do not extend the
orchestration read model. A thread is active work; when work begins, it belongs in a thread rather
than acquiring an `in_progress` follow-up state. Memory is for durable facts, while follow-ups are
consumed and closed. This boundary avoids loading a task list into every agent context and keeps
project-scoped deferrals out of provider and orchestration lifecycles.

## Boundary

The typed contract lives in [`packages/contracts/src/followups.ts`][contracts].
[`FollowUpService.ts`][service] owns commands, persistence, and the snapshot-plus-events stream;
the pure [decider][decider] owns state transitions. The shared client runtime reduces that stream,
and clients compose their own views from it. Provider adapters remain unaware of follow-ups: MCP
provides the common agent surface instead.

This narrow ownership is intentional. Follow-up behavior stays in its own module, with only the
contract and transport registration, migration registration, client composition, navigation, and
a shipping gate touching adjacent systems.

## Persistence and concurrency

`follow_up_events` is the durable append-only fact log. `follow_ups` is its read projection, kept
in the same SQLite transaction as each event append. The projection makes list and branch-gate
queries cheap without making it the source of truth.

Every command has a durable `command_id`; retrying one returns the item from its original event
instead of applying the mutation again. Status changes also carry `expectedRevision`, so an edit
made against an older item version is rejected rather than overwriting a concurrent change. The
service serializes mutations, validates project and optional thread links, invokes the decider,
then appends the event and updates the projection atomically. Subscribers attach under that same
serialization boundary before receiving a snapshot, preventing a snapshot/subscribe gap.

## Authority and lifecycle

Items are `blocker`, `open`, or `idea`. A blocker names the branch it gates; only unresolved
blockers for that exact branch can stop shipping. Leaving `open` requires a resolution note.

Agents may mark an item `resolved` after addressing it, or `moot` when evidence shows it no longer
applies. They cannot waive an item. Waiving is a human decision because allowing an agent to waive
its own blocker would let it bypass the shipping gate it is meant to respect.

## Beta and shipping gate

`followUpsEnabled` is a server-authoritative, default-off beta flag. It controls the UI, MCP
handler guards, and gate enforcement. The supported MCP registry is fixed when the server starts,
so enabling the flag requires an environment restart before agents can discover the newly
registered tools. Disabling immediately hides the UI and causes already registered handlers and
the gate to honor the disabled setting.

There is one shipping-boundary call site: [`GitManager.runPrStep`][git-manager] resolves the
authoritative final branch first, then calls the gate before provider resolution and before any
pull-request lookup or creation. The sole gate logic is in [`gate.ts`][gate], so adjacent shipping
code does not duplicate the query or policy.

[contracts]: ../../packages/contracts/src/followups.ts
[service]: ../../apps/server/src/followups/FollowUpService.ts
[decider]: ../../apps/server/src/followups/decider.ts
[git-manager]: ../../apps/server/src/git/GitManager.ts
[gate]: ../../apps/server/src/followups/gate.ts
