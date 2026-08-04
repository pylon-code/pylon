# Follow-ups — Design

**Status:** Proposed, awaiting review
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
- No scheduled background validation in v1 (see Validation).
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
- **`moot`** → validation determined it no longer applies. Requires evidence in `resolution`.
  Agents may set this, and it is challengeable.

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

1. **Shipping actions refuse** while unresolved blockers are attached to the same branch — PR
   creation and any Pylon-owned completion/merge path. Refusal names the blocking items.
2. **Gate status is visible on the branch in the UI**, so the developer sees it even if an agent
   glosses over it.
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
- `followup_resolve` — set `resolved` or `moot` with a `resolution`. **Cannot set `waived`.**
- `followup_check_gate` — report unresolved blockers for a branch.

Tools are registered only when the beta flag is on.

## Validation loop

The property that makes over-capture safe: items are cheap to re-check, so cleanup does not cost
human attention.

A validator agent reads `verifyCheck` and `evidence`, diffs against the current tree, and returns
still-needed / moot / uncertain. It also audits **classification honesty** — "is this really
out of scope, or did the filing agent dodge work it was asked to do?" — and may reclassify. The
closed reason set is therefore a checkable claim, not just guidance.

**When it runs (v1):**

- On demand, when the developer asks.
- At gate check, so a stale blocker cannot block shipping.

No scheduled background sweep in v1. A reactor mutating the list unasked burns tokens and feels
intrusive; add it only if the list grows enough to need it.

## Beta gating

Ships behind a toggle in the existing `BetaSettingsPanel.tsx` (precedent: sidebar v2), default
**off**. The flag must gate all three of:

1. the UI surfaces,
2. MCP tool registration,
3. gate enforcement.

A half-disabled state where agents file items the developer cannot see is worse than either
extreme.

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
- new migration (id **37**; id 36 is retired — see `Migrations.ts`)

**Registration touchpoints** (additive lines; conflict textually, resolve by keeping both):
`contracts/index.ts`, `contracts/rpc.ts`, `ws.ts`, `RpcAuthorization.ts`, `Migrations.ts`,
`server.ts`, `McpHttpServer.ts`, `BetaSettingsPanel.tsx`.

**Upstream cost, measured** against the last real batch (`30c962280..c30a6d9b9`, 94 files): six of
eight touchpoints were untouched by upstream. `server.ts` (+26/−6) and `McpHttpServer.ts` (+3/−1)
are churny, but both take additive registration lines.

**The one new risk** is the gate hook, which touches a completion path upstream actively develops.
Mitigation: exactly one line at the call site —
`yield* FollowUps.assertNoOpenBlockers(ref)` — with all logic inside the follow-ups module, so an
upstream conflict is a one-line "keep both" rather than a logic merge.

## Decisions made during design, open to reversal on review

1. **Acting on an item**: both paths supported — "start a thread from this" seeds the composer
   with the dossier, and an agent may resolve one inline in the current thread. The item records
   which via `resolution.threadId`. No `in_progress` state; no auto-linking of drafts (a draft has
   no thread identity until first send — the same trap Kanban hit).
2. **Resolved vs waived**: separate states with different permissions; agents may resolve and moot
   but never waive.
3. **Validation timing**: on demand and at gate check only; no scheduled reactor in v1.

## Success criteria

- A follow-up filed by an agent in one thread is actionable by a different agent, in a different
  thread, weeks later, without the original conversation.
- An agent cannot ship work past an unresolved blocker attached to that work.
- An agent cannot file a follow-up for work it was asked to do and could have done.
- Stale items can be identified without the developer reading them.
- Turning the beta flag off removes every trace from both the UI and agent tooling.
