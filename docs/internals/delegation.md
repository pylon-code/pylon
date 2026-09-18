# Delegated threads

The delegation MCP toolkit ([`apps/server/src/mcp/toolkits/delegation`](../../apps/server/src/mcp/toolkits/delegation))
lets an agent start and manage child threads on other provider instances. The toolkit itself is a
sidecar: it dispatches only existing commands (`thread.create`, `thread.meta.update`,
`thread.turn.start`, `thread.turn.interrupt`, `thread.delete`) and reads only existing projections.
Automatic parent follow-through (PR #603) is not: it adds the internal
`thread.delegation.follow-through` command to the contracts, a decider branch that admits it, and
two projection queries. Removing delegation therefore means deleting the toolkit directory, the
reactor, and those three core touches together. The toolkit deliberately does not reuse upstream's
reserved `delegate_task`, `task_status`, or `task_cancel` tool names.

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

The follow-through reactor observes children with `observeDelegatedChild`, which must agree with
`deriveDelegatedThreadState` on completed children: a turn's own terminal state wins over a session
that was stopped afterwards by a restart or the idle reaper. At startup, any child whose observation
differs from the persisted one is baselined rather than delivered, because children only run inside
the server process and nothing could have observed that change live.

A parent can also read a child's state inside its own turn, through `pair_await`,
`delegated_thread_status`, or `delegated_thread_result`. When what those return is a finished attempt
(completed, error, or interrupted), `markDelegationObservationConsumed` writes the reactor's own
`delegation.child-state` receipt for that `noticeKey` with `baseline: true`. Activities are stored
by id, so it replaces whatever the reactor recorded while the parent was busy, and the reactor's
existing rule then skips the wake. Either order of the two writes gives the same result. Running
children and children that need the user are never marked, so those wakes still happen. The writer
never fails a tool call; if it cannot write, the cost is one redundant wake.

## Defaults and agent guidance

`delegationDefaultModelSelection` and `delegationChildRuntimeMode` are project-scoped settings resolved
from the parent's project when `delegate_thread` runs. An explicit provider in the call ignores the
default entirely. An explicit model without a provider keeps the default's provider but drops its model
options. With neither and no default, the call fails rather than choosing a provider. A default is
validated exactly like an explicit choice, and an unavailable one fails. The new keys are deliberately
not in `resolveProjectSettings`' disabled-provider fallback, which would otherwise swap a project's
default for the environment's without saying so.

Provider runtime instructions and MCP tool descriptions route agents to `read_delegation_skill`.
Prime Agent uses the tool description because it does not receive Pylon runtime instructions.
The canonical repo skill is embedded in the server bundle so installed servers need no source checkout.
The read resolves the current parent project's `delegationPreference`, defaulting to built-in agents
and treating a saved Pylon preference as inactive while delegation is disabled. Reading at task
routing time avoids freezing a preference in provider session instructions. Explicit user instructions
override the preference; neither availability nor preference means every task should be delegated.
Provider/model defaults are still resolved at child creation and reported in `defaultApplied`.

## The pair executor

The pair toolkit ([`apps/server/src/mcp/toolkits/pair`](../../apps/server/src/mcp/toolkits/pair))
links a lead thread to one persistent executor. The executor's id is the delegated child id for the
reserved key `pair`, so every client and the server can compute it from the lead's id and nothing
records the link. The fan-out tools refuse that key. A pair is on when that thread exists and is not
archived.

The executor is created with the lead's `branch` and `worktreePath`: it works in the lead's checkout,
so the lead reviews its own tree and no worktree is created or cleaned up. Two threads on one
checkout is already how local-mode threads behave. The executor is always created in the default
interaction mode, because a lead in plan mode plans and its executor implements.

An executor that never ran reads as `idle`, where the fan-out derivation says `queued`: it is
created without a first message and waits for a brief. A brief to a running executor is refused
unless the lead asks to steer, and a turn can be steered once: the steer message id is derived from
the turn id, so the limit survives restarts. `pair_await` blocks inside the tool call, which costs no
tokens, up to a cap chosen by the lead's provider: long only where Pylon sets that provider's MCP
tool timeout itself. The lead does not choose the length. A live Codex lead asked for 10 to 20
seconds at a time and looped, which is polling with a model turn per call, so any request other than
an explicit 0 waits the whole cap; the call still returns the moment the executor changes state, and
0 reads the state without waiting. Instant reads are rationed too: a lead may glance at a running
executor twice in a row, and a third `maxSeconds: 0` waits the whole cap instead (`pairAwaitPlan`), so
no argument turns the tool into a poll. Any wait, or finding the executor not running, clears the
count, which lives in memory beside the protected-path record. Its `filesChanged` covers the executor's latest turn only: one
executor serves every brief of a pair, so listing all of its checkpoints would hand the lead files it
reviewed several briefs ago. `turnCount` still counts them all.

Pairing is session-scoped. When a provider session is prepared, `ProviderService` adds a `pair`
capability if the thread's executor exists and is not archived. The `enableAgentDelegation` setting
is not consulted: it covers what an agent starts on its own, and a pair is switched on by the user
for one thread. So `pair_start` still requires the `delegation` capability, while `pair_handoff`,
`pair_await` and `pair_stop` accept either one, and the follow-through reactor and the engine's
admission of its wake let a pair executor through with the setting off (`followThroughChildren`,
`isFollowThroughAdmitted`). Fan-out children stay silent in that case. Adapters read the `pair`
capability too. A paired Claude query denies the Agent tool (named Task in older
Claude Code), a paired Codex app-server starts with `features.multi_agent=false` and
`features.multi_agent_v2=false`, and every harness that receives Pylon instructions gets the pair
protocol in place of the delegation block. Nothing is
written to a provider's own settings, so a thread that is not paired behaves exactly as the provider
ships. A pair started mid-session reaches the lead through the `pair_start` result, which carries the
same protocol text; the tool denial applies from the next session start. Prime Agent's own subagent
depth is not yet held while paired.

Antigravity cannot lead and is refused by `pair_start` and by the clients, though it works as the
executor: it offers no per-session control over its own subagents and receives no Pylon
instructions. Codex can lead, but for it the protocol is the only control. Codex 0.153.4 keeps all
six `collaboration.*` tools with both flags above off (checked with
`codex exec -c features.multi_agent=false -c features.multi_agent_v2=false`), and its `t3-code`
tools are deferred behind tool discovery, so a Codex lead that is not told about the pair tools
spawns its own subagent on its own model instead. That happened in every run until Pylon's
instructions reached Codex (see the Codex protocol traps in [providers](providers.md)). With them, a
fresh Codex lead made one `pair_handoff` and one `pair_await`, a Claude executor did the work, and no
collaboration tool was called. Claude and Prime Agent leads were verified the same way, Prime on its
native daemon with an OpenAI Codex model; its log does not name tools, so the evidence is the
`pair-message:` brief on the executor and the consumed receipt on the lead.

A paired thread does not fan out. `delegate_thread` refuses with `DelegationPairedError` while the
thread's executor exists and is not archived, and `read_delegation_skill` returns the pair protocol
there instead of the fan-out workflow. Both check the projection rather than the session's `pair`
capability, so a pair started mid-session is covered at once. This came from use, not design: a
paired Claude lead that was told to "use delegation" looked up the delegation tools, read the skill,
started two children, and never briefed its executor. The status, result, send and interrupt tools
still work, so children from before the pair can be wound down.

The executor follows its lead. `PairLifecycleReactor` watches domain events and dispatches existing
commands: archiving, settling, or deleting a lead does the same to its executor, including an
executor that was archived when the pair was turned off. An executor's own lifecycle never echoes
back, because archiving it is how a user turns the pair off, and unarchiving a lead does not turn a
pair back on. A rewind of the lead is not blocked, since that would mean changing rewind admission in
the decider. Instead the reactor interrupts a running executor the moment the rewind is requested: the
two threads share one worktree, and an executor that kept editing would write over the restored
files. It may still write for a moment before the interrupt lands. The idle-session reaper skips an
executor while its lead's session is starting or running, so it is not restarted between briefs. The
reactor reads no settings: following a lead is cleanup and keeps working after delegation is turned
off.

A brief can name the files its lead owns, normally its tests and contract, as `protectedPaths`.
The handlers hash each file when the brief is accepted and `pair_await` reports the ones whose
content changed or that disappeared, once the executor is no longer running. This is what makes
"make these tests pass without editing them" checkable. A path that is absolute, contains `..`, or
cannot be read refuses the brief before a turn starts. A steer keeps the record, each new brief
replaces it, and a replayed `messageKey` cannot reset the baseline. The record lives in memory: a
brief-to-await cycle rarely spans a restart, and after one `pair_await` reports `null` rather than
guessing. Persisting it would have meant activity rows that both clients would then have to hide.

`pair_handoff` also corrects the executor's location. A pair turned on from the composer creates
the executor before the lead's first turn has set up its worktree, and a lead can move to another
branch. Rather than chase that through events, an ordinary brief compares the executor's `branch`
and `worktreePath` with the lead's and dispatches one `thread.meta.update` first when they differ.
Protected paths are hashed against the root the executor is about to have, a refused path stops the
brief before anything moves, and a steer never moves a running executor.

## Accepted limits

- A follow-up is refused while the child is running, but a user message can arrive between the
  check and the dispatch; the follow-up then steers that turn, as any turn start on a running turn
  does. Not guarded.
- The per-parent semaphore that serializes delegation is in memory, which is enough because one
  server process owns the orchestration engine.
- Waiting is polling of the projection inside the tool call, bounded by wall-clock time to 45
  seconds. `delegated_thread_status` does not let the caller pick a shorter wait either: omitted or 0
  reads the state, any positive value waits the whole 45 seconds (`delegatedStatusWaitSeconds`); already-settled children and pending approvals/input return immediately. Prime Agent's MCP client cancels any call after 60 seconds, measured in a live run.
  Pylon disables Prime's autonomous continuation, so a parent cannot be woken when a child finishes.
- The per-parent semaphores are never evicted; one small entry per thread that has delegated.
- Sends and interrupts take the same per-parent gate as delegation, so an interrupt waits behind a
  delegation in progress, including its git fetch. Status and result reads do not take the gate.
- Interrupts use a unique command id per call rather than a deterministic one. Every deterministic
  key tried (per turn, per admission) let a later interrupt replay an earlier receipt and dispatch
  nothing; a duplicate interrupt on a live child is harmless.
- Worktree creation mirrors the websocket bootstrap sequence without sharing code with `ws.ts`, and
  does not run project setup scripts. Changes to how clients create worktrees must be checked here.
