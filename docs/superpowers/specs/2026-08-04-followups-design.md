# Follow-ups — Design

**Status:** Implemented and follow-on hardened
**Date:** 2026-08-04

## The problem

While working, the developer constantly notices things that need doing later — and agents surface
follow-ups too. There is nowhere to put them. They live in prose, in the developer's head, or in
scratch files, and they get lost. The cost is a standing mental tax across multiple projects.

Three follow-ups arose in a single session on 2026-08-04 and all three depended on the developer
personally catching them:

1. A pre-existing Select bug was flagged "out of scope" and only fixed because the developer
   asked a follow-up question.
2. An accessibility risk was parked in an SDD ledger; the ledger was then deleted as routine
   workspace cleanup. The finding is gone.
3. A toolchain gotcha (`vp` resolving globally) was hand-written into `AGENTS.md` by the developer.

An agent noticing something and saying it in prose is not tracking.

## Why not the things we already have

- **Threads** are work in progress. Follow-ups are explicitly work _not_ being done now. The
  Kanban board failed precisely because a work item was a 1:1 shadow of a thread (see the removal
  commit `d31439f62` and its merge `fc6568c15`). Follow-ups must stay on the other side of that
  line: if it is being worked, it is a thread, not a follow-up.
- **Memory** holds facts that stay true. Follow-ups are items that get consumed and should
  disappear. Memory has no lifecycle, no triage view, no ordering, and loads into context every
  session — a growing list would silently consume the context window.
- **Agent TODOs** (`TodoWrite` → `PlanStep[]`) are turn-scoped steps for finishing the current
  task. They die with the turn. That is correct for what they are, and it is not this.

## Non-goals

- Not a project manager, sprint tool, or issue tracker.
- Not a work queue. Agents do not "pull work" from it autonomously.
- No cross-project aggregate view in v1. Items are project-scoped.
- No automatic or scheduled provider-run validation in v1 (see Validation).
- No mobile UI in v1. Contracts stay client-agnostic so mobile can follow.

## Core model

A follow-up is a small dossier, not a string. It must be actionable and challengeable by a
_different_ agent, weeks later, with none of the originating conversation.

| Field                     | Type                                                           | Purpose                                             |
| ------------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| `id`                      | `FollowUpId`                                                   |                                                     |
| `projectId`               | `ProjectId`                                                    | Scope. Follow-ups are per project.                  |
| `kind`                    | `blocker \| open \| idea`                                      | See Kinds.                                          |
| `status`                  | `open \| resolved \| waived \| moot`                           | See States.                                         |
| `title`                   | trimmed, ≤200                                                  | Human-scannable in a list.                          |
| `observation`             | trimmed, ≤8000                                                 | What was actually seen, in enough detail to act on. |
| `deferReason`             | `out-of-scope \| needs-decision \| blocked-externally \| idea` | Closed set. See Capture rules.                      |
| `verifyCheck`             | trimmed, ≤2000                                                 | Falsifiable check for "is this still needed?"       |
| `evidence`                | array of `{ path, line?, commitSha }`                          | Anchors for a later validator to diff against.      |
| `gate`                    | nullable `{ kind: "branch", ref: string }`                     | Blockers only. What this blocks.                    |
| `sourceKind`              | `human \| agent`                                               | Provenance.                                         |
| `sourceThreadId`          | nullable `ThreadId`                                            | Thread it was filed from.                           |
| `resolution`              | nullable `{ note, threadId?, commitSha? }`                     | How it ended. Required to leave `open`.             |
| `lastValidation`          | nullable validation record                                     | Latest durable check; full history stays in events. |
| `createdAt` / `updatedAt` | ISO                                                            |                                                     |

`verifyCheck` is the load-bearing field. Without it, revalidation is guesswork. Examples from the
three real cases above: _"open the board's project picker — does it show a name or a UUID?"_,
_"does the sortable wrapper still carry role=button while containing buttons?"_, _"does
`vp test run` still fail at describe()?"_ — note the third would now correctly self-expire.

### Kinds

Each kind is decided by a test, not a feeling. Three levels only; five-level schemes collapse into
"everything is P1" within a month.

- **`blocker`** — _"Would a competent reviewer refuse to merge this work because of it?"_
  Must carry a `gate`. "Before shipping" is meaningless without naming what it blocks.
- **`open`** — _"Real work that should happen, but is not part of what ships now."_
- **`idea`** — _"Did anyone ask for this, or did I just think of it?"_ Explicitly allowed to never
  happen. This bucket exists so speculative suggestions have a guilt-free home and stop
  contaminating the real list.

### States

- **`open`** → the default.
- **`resolved`** → the thing was actually done. Requires a `resolution` note; a thread and/or
  commit ref where possible. Agents may set this.
- **`waived`** → a human decided it does not need doing. **Agents may never set this.** If an
  agent could waive, the gate would be self-defeating.
- **`moot`** → validation determined it no longer applies. A direct status update cannot select
  this state; it comes from an evidence-backed validation record.

No `in_progress` state. If something is being worked, that is a thread — keeping the state out
preserves the boundary that Kanban violated.

## Capture rules

These are the integrity core. Without them the list becomes a laundering mechanism for unfinished
work, which is worse than having no list.

**The bright line, to appear verbatim in agent guidance:**

> Before filing a follow-up, ask: _was I asked to do this, and can I do it now?_ If yes, filing is
> forbidden — do the work.

Only work failing that test is eligible. Eligible work must then carry a `deferReason` from the
closed set:

- `out-of-scope` — genuinely outside what was asked
- `needs-decision` — needs a product or design call only the developer can make
- `blocked-externally` — missing access, upstream dependency, environment
- `idea` — nobody asked; the agent thought of it

Explicitly invalid: "ran out of time", "seemed hard", "probably fine". A closed set makes lazy
deferral unrepresentable rather than merely discouraged. An agent that cannot name a valid reason
must finish the work or say it is stuck.

The developer may file anything at any time, by asking an agent in conversation
("add a follow-up to check X") or through the UI. No rules apply to human capture.

## The gate

The anti-oblivion mechanism, and the reason this is not another passive list.

**What is genuinely enforceable:** an LLM cannot be mechanically prevented from typing "all done".
There is no system event for _claiming_ completion. So enforcement attaches to the actions that
constitute shipping, which are real code paths that can refuse:

1. **Change-request creation refuses** while unresolved blockers are attached to the same
   project and branch. `GitManager.runPrStep` is the sole enforced shipping boundary. It derives
   the final branch and repository path before provider resolution or change-request lookup.
   Unknown or ambiguous repository ownership fails closed, and refusal names the blockers.
2. **Gate status is visible on the branch in the UI**, so the developer sees it even if an agent
   glosses over it. A query failure remains visibly unavailable and retains the last synchronized
   count rather than looking clear.
3. **`followup_check_gate`** lets an agent query gate state deliberately before claiming done.

Leaving the gate requires `resolved`, `waived` (human only), or `moot`. This is a hard gate by
the developer's choice (2026-08-04), accepting occasional friction; if it proves annoying, the
fallback is a loud non-blocking surface, which is a one-line policy change.

## Agent awareness

**Constraint discovered during design:** Pylon has no context-injection hook. Providers read
`CLAUDE.md` / `AGENTS.md` natively; Pylon never appends to agent context. Building injection would
mean touching all five provider adapters — expensive, and exactly the per-adapter work the repo
warns about.

v1 therefore uses the existing native path:

- Agents reach follow-ups through the **MCP toolkit** (below), which Pylon already serves.
- A short instruction in the project's agent file tells agents to call `followup_list` when
  starting work and before reporting completion.
- The **gate** is the mechanical backstop, so awareness failure degrades to "the agent is
  surprised at ship time" rather than "the item is lost".

Automatic injection is deferred until the beta shows it is needed.

## MCP tool surface

A `followups` toolkit at `apps/server/src/mcp/toolkits/followups/{tools,handlers}.ts`, following
the existing `preview` toolkit pattern. Works for any MCP-capable provider with no per-adapter
work.

- `followup_file` — file one. Requires `title`, `observation`, `deferReason`, `verifyCheck`,
  `kind`; `gate` required when `kind` is `blocker`. Rejects unknown `deferReason`.
- `followup_list` — list for the current project; filter by kind/status/gate.
- `followup_resolve` — set `resolved` with a resolution. **Cannot set `moot` or `waived`.**
- `followup_check_gate` — report unresolved blockers for a branch.
- `followup_record_validation` — record a completed visible validation as `still-needed`, `moot`,
  or `uncertain`; only an evidence-backed `moot` closes the item.

The supported MCP registry is fixed when the environment starts. Enabling the beta therefore
requires one restart before agents can discover these tools. Live handler guards still reject
calls immediately after disabling, even when the names remain discoverable until restart.

## Validation loop

The property that makes over-capture safe: items carry enough information for an explicit,
challengeable re-check.

A developer starts validation from the list. Pylon opens a normal, visible project thread with a
read-only validation prompt containing `verifyCheck` and `evidence`. The agent performs the check,
then records `still-needed`, `moot`, or `uncertain` through MCP. The durable record includes its
note, evidence, validation thread, checked commit, and server timestamp; the projection retains
the latest result and the event log retains the history. `still-needed` and `uncertain` leave the
item open. `moot` requires evidence and closes it atomically.

**When it runs (v1):**

- On demand, when the developer chooses **Validate**.

The shipping gate does not launch a provider. It has no durable validation job, thread, model,
permission, cancellation, or uniformly read-only provider session to own that work safely. It
therefore checks the durable state and fails closed. No scheduled background sweep runs in v1.

## Beta gating

Ships behind a toggle in the existing `BetaSettingsPanel.tsx` (precedent: sidebar v2), default
**off**. The flag must gate all three of:

1. the UI surfaces,
2. MCP tool registration,
3. gate enforcement.

A half-disabled state where agents file items the developer cannot see is worse than either
extreme. UI availability is tri-state while environments connect: pending renders a loading
surface, available renders the list, and unavailable redirects away. Disabling is live for UI,
handlers, streams, and the gate; only MCP tool discovery waits for restart as described above.

## Architecture

Approach: **bounded context plus one thin completion hook** — the same architecture Kanban used.
That architecture was sound; Kanban failed on product, not structure. Its removal touched zero
orchestration files, which is the evidence.

**New, isolated (no upstream conflict surface):**

- `packages/contracts/src/followups.ts`
- `apps/server/src/followups/{FollowUpService,decider}.ts` + tests
- `apps/server/src/mcp/toolkits/followups/`
- `packages/client-runtime/src/state/followups.ts`
- `apps/web/src/components/followups/`
- migrations **37** (events and projection) and **38** (durable validation evidence); id 36 is
  retired — see `Migrations.ts`

**Registration touchpoints** (additive lines; conflict textually, resolve by keeping both):
`contracts/index.ts`, `contracts/rpc.ts`, `ws.ts`, `RpcAuthorization.ts`, `Migrations.ts`,
`server.ts`, `McpHttpServer.ts`, `BetaSettingsPanel.tsx`.

**Upstream cost, measured** against the last real batch (`30c962280..c30a6d9b9`, 94 files): six of
eight touchpoints were untouched by upstream. `server.ts` (+26/−6) and `McpHttpServer.ts` (+3/−1)
are churny, but both take additive registration lines.

**The one new risk** is the gate hook, which touches a completion path upstream actively develops.
The implemented boundary is one call from `GitManager.runPrStep` to
`FollowUps.assertNoOpenBlockers(branchRef, cwd)`. All project lookup, query, and policy remain in
the follow-ups module so the shipping workflow does not duplicate them.

The service treats project identity as an authorization boundary. Item, thread, snapshot, stream,
and gate queries validate the requested project. Repository-path lookup accepts exactly one
distinct matching project across root and worktree paths; zero or multiple matches fail closed.
Subscribers attach before snapshots are read, both for follow-ups and for the settings stream that
controls their availability, so a concurrent update cannot fall into a snapshot/subscribe gap.

## Decisions retained from design

1. **Acting on an item**: **Start thread** and **Validate** seed the composer with distinct,
   Pylon-owned framed sections. Switching modes replaces only the matching owned frame and
   preserves every byte outside it. The resulting normal thread can later be linked in resolution
   or validation evidence. No `in_progress` state; no auto-linking of drafts (a draft has no
   thread identity until first send — the same trap Kanban hit).
2. **Resolved vs waived**: separate states with different permissions; agents may resolve directly
   and may produce moot only through evidence-backed validation, but never waive.
3. **Validation timing**: on demand only; no provider launch at the gate and no scheduled reactor
   in v1.
4. **Reverse states and evidence**: the UI supports **Reopen**, shows resolution metadata, and
   renders validation evidence with full commit and timestamp values available to inspect.

## Success criteria

- A follow-up filed by an agent in one thread is actionable by a different agent, in a different
  thread, weeks later, without the original conversation.
- Pylon refuses its change-request action while an unresolved blocker is attached to that project
  and branch.
- Agent guidance and the tool contract make the bright-line filing rule explicit and require a
  closed defer reason; this is a policy boundary, not a mechanically provable property.
- Stale items can be identified without the developer reading them.
- Turning the beta flag off immediately removes the UI and disables handlers, streams, and gate
  enforcement; a restart refreshes the fixed MCP discovery catalog.
