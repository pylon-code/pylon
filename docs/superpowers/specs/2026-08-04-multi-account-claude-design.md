# Multi-account Claude: usage visibility, drain-and-swap routing, thread handoff

Date: 2026-08-04

## Problem

A developer with two Claude subscriptions wants Pylon to use both: work one account
until its rate-limit window is exhausted, then continue on the other. Today Pylon can
run both accounts but only by switching manually, with no visibility into how much
capacity either has left.

## What the platform actually gives us

Verified on 2026-08-04 rather than assumed. These findings shape every decision below.

| Finding                                             | Evidence                                                                                                                                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials isolate per `CLAUDE_CONFIG_DIR`         | A fresh config dir reports `loggedIn: false` while the default reports the signed-in account. macOS keychain entries are hash-suffixed per config dir (`Claude Code-credentials-<hash>`), so two accounts can be signed in at once. |
| Session transcripts are account-agnostic            | Transcript JSONL keys are `cwd`, `sessionId`, `message`, `uuid`, `parentUuid`, `gitBranch`, … — no account, org, or subscription identifier.                                                                                        |
| `--resume` works across config dirs                 | A session created on account A, its transcript copied to account B's config dir, resumed on B and recalled a token from the prior turn. Lossless.                                                                                   |
| `rate_limit_event` omits `utilization` at low usage | Real event carried `{status, resetsAt, rateLimitType, overageStatus}` only. `utilization` is optional in the SDK type and was absent. Re-verified on 2.1.220 at 12% session / 16% weekly — still absent.                            |
| `GET /api/oauth/usage` returns structured usage     | Private OAuth endpoint (`Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`) returns continuous percentages and reset times for every window as JSON — what claude.ai's own UI renders. Answers 429 under load.     |
| `claude --print "/usage"` reports *local* figures   | Costs nothing (`total_cost_usd: 0`, zero tokens) but its output is human text, and its percentages derive from this machine's sessions: 17% weekly against the endpoint's 40% for the same account, seconds apart.                  |
| Prompt caches never cross organizations             | Anthropic: "Caches are isolated between organizations. Different organizations never share caches, even if they use identical prompts."                                                                                             |

Two consequences follow directly:

- **Every account switch costs a full cold prefix.** Cache reads bill at 0.1x base input;
  a cold write bills 1.25x (5-minute TTL) or 2x (1-hour, which Claude Code uses). Switching
  is therefore expensive and must be rare and sticky, never load-balanced.
- **Drain detection is reactive.** Without `utilization` there is no reliable pre-emptive
  signal, so exhaustion is detected when a turn is rejected. This matches the desired
  behavior — the goal is to drain an account, not to avoid filling it.

## Design

### Phase A — usage visibility (this branch)

Adopts upstream T3 Code PR #4326 (`pingdotgg/t3code@0abc172d`), which threads
`ServerProviderUsageLimits` through the existing provider snapshot. Codex reads the typed
`account/rateLimits/read`. Usage is best-effort and fails closed — a timeout or an
unrecognized payload omits usage without degrading provider readiness.

**Claude no longer scrapes the CLI.** Upstream parsed `claude --print "/usage"`, whose prose
output changed shape twice between #4326 and this branch (a stream-message array replaced the
single JSON object, and the reset separator became `at`), each time failing silently. Pylon
reads `GET /api/oauth/usage` instead: structured JSON, per-account via the config dir's
keychain entry, and accurate where the CLI reported only this machine's share. Credentials are
read, never refreshed or written — Pylon needs a gauge, not a session.

The scrape was removed rather than kept as a fallback. Its numbers describe something
different, so falling back would silently swap one figure for another; a briefly absent gauge
beats a quietly wrong one.

Pylon adaptations:

- **Multi-account popover.** Upstream binds the context-window popover to the active thread's
  single instance. Pylon renders every configured instance of the active thread's driver,
  marking the bound one. A single configured account collapses to upstream's exact layout, so
  single-account setups see no added chrome.
- **`showProviderUsageInContextPopover` defaults on.** Upstream defaults it off as a niche
  readout; with account routing it is routine information.

The context popover is the deliberate home for the *full* gauge — every window with its reset
time. It is a lookup, it sits beside the context-window meter that answers the structurally
identical "how much room do I have" question, and it costs no resting screen real estate.

A two-window summary (session and account-wide weekly, as percentages with fill bars) also
sits in the composer context strip, opposite the workspace controls. That was added after
living with the popover: while draining an account deliberately, "how close am I" is a glance,
not a lookup. Model-scoped weeklies stay in the popover.

### Phase B — drain-and-swap routing

- **Instance priority.** An explicit order over configured instances (Primary, Secondary, …).
  Not round-robin and not most-capacity-first: an ordered list drains one account fully before
  moving on, which is both the requested workflow and the cache-optimal policy.
- **Limit ledger.** A projection over `account.rate-limits.updated`, which `ClaudeAdapter`
  already emits and nothing currently consumes. Stores `status`, `resetsAt`, and
  `rateLimitType` per instance.
- **New-thread routing.** New threads open on the highest-priority non-drained instance.
  Existing threads never move on their own. New threads have no cache to lose, so this
  is the free lever and should be used aggressively.
- **Drain pill.** A _conditional_ pill in the existing `SidebarChromeFooter` stack, alongside
  `SidebarProviderUpdatePill` and `SidebarUpdatePill`. It appears on drain or switch and is
  otherwise absent. A persistent indicator was rejected: the gauge belongs in the popover, and
  a ticking countdown would violate the repo's no-continuous-repaint rule.

The two sources are complementary, not alternatives. `GET /api/oauth/usage` (5-minute cached
poll, 1-minute backoff on failure since it answers 429 under load) drives the gauge;
`rate_limit_event` (typed, pushed live during a session) drives routing. Routing therefore has
no dependency on the polled source at all — a gauge outage cannot misroute a turn.

The five-color status language in `docs/user/status-indicators.md` describes _thread_ state and
is deliberately not reused for account capacity. Account identity uses the existing per-instance
`accentColor`.

### Phase C — thread handoff

When an account drains mid-thread, continue the work on another account.

**Rejected: copying Claude's session transcript between config dirs.** It works — proven above —
but it depends on an undocumented on-disk layout, writes into another program's private state,
and breaks on Anthropic's release schedule. It also saves nothing: a cross-org switch pays a full
cold prefix either way, so the hack buys structural fidelity, not efficiency.

**Chosen: replay from Pylon's own event log.** Pylon is already the source of truth — the
projector renders the entire chat view from it. A handoff builds a fresh session on the target
account from three layers:

1. **Verbatim** — the original request and the last N turns.
2. **Summarized** — older turns, via the existing per-provider `textGeneration/` subsystem.
3. **Git-anchored** — the checkpoint diff from thread start to now, via
   `checkpointing/CheckpointDiffQuery.ts`.

Layer 3 is what makes this trustworthy: a model-written summary can invent what it did, a git
diff cannot. Anchor facts on the diff and use prose only for intent and open questions.

Shipped as an explicit **"Continue in a new thread"** action, linked to its parent and visibly
marked as continued. Visible seams are the point — a user who sees the marker understands why
the agent re-asked something. Automatic drain-triggered handoff is the same action fired by the
ledger, defaulting on because Pylon is frequently driven async.

This also works across _providers_, not just accounts — continuing a Claude thread on Codex is
the same mechanism.

Accepted loss: the new agent receives a report of prior work rather than the lived context. On a
long thread some reasoning is lost. This is what already happens when any long thread compacts.

## Scope boundaries

Originally three branches, one concern each. A and B shipped together on
`feat/2026-08-04-account-drain-routing` so the drain-and-swap workflow could be exercised
end to end in one build; C remains separate.

| Branch | Concern                               | Depends on                                        | State    |
| ------ | ------------------------------------- | ------------------------------------------------- | -------- |
| A      | Adopt #4326 + multi-account popover   | —                                                 | Shipped  |
| B      | Priority, ledger, routing, drain pill | A                                                 | Shipped  |
| C      | Thread handoff                        | B for the auto-trigger; manual form needs nothing | Not started |

Deferred: mobile surfaces (upstream touches no mobile files), Grok/Cursor/OpenCode usage,
credit balances and usage-based plans, persistent usage caches.

## Open questions

- Whether a reset Primary should pull _new_ threads back. Leaning yes, with existing threads
  still never moving. One-line policy, decide after living with it.
- Whether `utilization` appears in `rate_limit_event` under real load. If it does, pre-emptive
  switching becomes possible as an optimization; the reactive path remains the correctness
  guarantee either way. Note the OAuth endpoint already reports continuous percentages, so
  this now matters only for routing, not for the gauge.
- Whether the OAuth endpoint's rate limit is tight enough to matter with several accounts
  configured. One 429 was observed during development; a 5-minute success TTL and 1-minute
  failure backoff were sized against that single data point.

## Note on account provenance

The second account configured during this work is a Team seat in an employer organization, not a
second personally-owned subscription. Team seats meter differently, and the org pushes policy the
personal account does not carry (`policy-limits.json` restrictions). Whether pooling an
employer-provided seat is appropriate is an organizational question, not a technical one. The
engineering is identical for any two instances.
