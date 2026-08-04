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
| `rate_limit_event` omits `utilization` at low usage | Real event carried `{status, resetsAt, rateLimitType, overageStatus}` only. `utilization` is optional in the SDK type and was absent.                                                                                               |
| `claude --print "/usage"` costs nothing             | `total_cost_usd: 0`, zero input and output tokens. Reports session and weekly windows with percentages and reset times as human-readable text.                                                                                      |
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
`account/rateLimits/read`; Claude parses `claude --print "/usage"`. Usage is best-effort and
fails closed — a timeout or changed output omits usage without degrading provider readiness.

Pylon adaptations:

- **Multi-account popover.** Upstream binds the context-window popover to the active thread's
  single instance. Pylon renders every configured instance of the active thread's driver,
  marking the bound one. A single configured account collapses to upstream's exact layout, so
  single-account setups see no added chrome.
- **`showProviderUsageInContextPopover` defaults on.** Upstream defaults it off as a niche
  readout; with account routing it is routine information.

The context popover is the deliberate home for the gauge. It is a lookup, it sits beside the
context-window meter that answers the structurally identical "how much room do I have"
question, and it costs no resting screen real estate.

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

`/usage` (5-minute cached poll) and `rate_limit_event` (pushed live during a session) are
complementary, not alternatives. The poll drives the gauge; the event drives routing.

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

Three branches, one concern each:

| Branch | Concern                               | Depends on                                        |
| ------ | ------------------------------------- | ------------------------------------------------- |
| A      | Adopt #4326 + multi-account popover   | —                                                 |
| B      | Priority, ledger, routing, drain pill | A                                                 |
| C      | Thread handoff                        | B for the auto-trigger; manual form needs nothing |

Deferred: mobile surfaces (upstream touches no mobile files), Grok/Cursor/OpenCode usage,
credit balances and usage-based plans, persistent usage caches.

## Open questions

- Whether a reset Primary should pull _new_ threads back. Leaning yes, with existing threads
  still never moving. One-line policy, decide after living with it.
- Whether `utilization` appears in `rate_limit_event` under real load. If it does, pre-emptive
  switching becomes possible as an optimization; the reactive path remains the correctness
  guarantee either way.

## Note on account provenance

The second account configured during this work is a Team seat in an employer organization, not a
second personally-owned subscription. Team seats meter differently, and the org pushes policy the
personal account does not carry (`policy-limits.json` restrictions). Whether pooling an
employer-provided seat is appropriate is an organizational question, not a technical one. The
engineering is identical for any two instances.
