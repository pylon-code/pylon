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

Project identity is authoritative at every boundary. WebSocket subscriptions and mutations name a
project, but the service verifies ownership; the WebSocket server stamps human provenance. MCP
does not accept a project or provenance from the tool caller: it derives both from the invocation
thread and stamps agent provenance. Git derives gate scope from the persisted project/worktree
projection for the repository path. No list, stream, mutation, replay, or same-named branch query
falls back to environment-wide data.

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

Validation adds `follow-up.validated` events. The projection retains `lastValidation`, while the
append-only event log preserves earlier checks. A validation records its verify check, outcome,
note, evidence, invocation thread, checked commit, and server timestamp in the same revision-checked
command. `still-needed` and `uncertain` increment the revision but stay open. `moot` requires
evidence and atomically records the validation and closes the item. Direct status changes cannot
mark an item moot.

## Authority and lifecycle

Items are `blocker`, `open`, or `idea`. A blocker names the branch it gates; only unresolved
blockers for that exact branch can stop shipping. Leaving `open` requires a resolution note.

Agents may mark an item `resolved` after addressing it. To mark one `moot`, an agent performs a
visible, read-only validation in a normal thread and records an evidence-backed result through
MCP. Agents cannot waive an item. Waiving is a human decision because allowing an agent to waive
its own blocker would let it bypass the shipping gate it is meant to respect. Reopening clears the
resolution but retains the last validation as history.

## Beta and shipping gate

`followUpsEnabled` is a per-environment, server-authoritative, default-off beta flag. It controls
the UI, WebSocket and MCP handler guards, and gate enforcement. The supported MCP registry is fixed when the server starts,
so enabling the flag requires an environment restart before agents can discover the newly
registered tools. Disabling immediately hides the UI, rejects already registered handlers, and
causes existing WebSocket subscriptions to fail before another item can be emitted; the gate also
honors the live disabled setting.

There is one shipping-boundary call site: [`GitManager.runPrStep`][git-manager] resolves the
authoritative final branch first, then calls the project-scoped gate before provider resolution and
before any change-request lookup or creation. The sole gate logic is in [`gate.ts`][gate], so adjacent shipping
code does not duplicate the query or policy.

The gate deliberately does not launch a provider to validate blockers. At this boundary Pylon has
only a repository path and branch: it has no durable job, thread, model, permission, cancellation,
or uniformly read-only provider session to run safely. Some provider text-generation adapters are
not a read-only execution boundary, and stacked actions may already have committed and pushed by
the time the change-request step runs. Until a dedicated durable validation-job abstraction owns
those capabilities, the gate stays fail closed and validation remains an explicit visible thread
flow.

[contracts]: ../../packages/contracts/src/followups.ts
[service]: ../../apps/server/src/followups/FollowUpService.ts
[decider]: ../../apps/server/src/followups/decider.ts
[git-manager]: ../../apps/server/src/git/GitManager.ts
[gate]: ../../apps/server/src/followups/gate.ts
