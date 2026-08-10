# Jcode SDK blockers

> For maintainers. Using Pylon? See [docs/user](../user/).

Jcode ships as an Early Access provider with a deliberately narrow surface. Everything below is
blocked on the Jcode SDK, not on Pylon plumbing: each entry names what protocol v1 would have to
expose before Pylon could enable the corresponding feature honestly.

The rule this ledger enforces is the same one the adapter follows: Pylon advertises a capability
only when the provider can be observed to satisfy it. Simulating a capability by inference — a
guessed approval, a reconstructed history, an assumed queue — is worse than reporting it
unavailable, because a client cannot tell a wrong answer from a real one.

## Requirements before enabling

1. **Sequenced event replay and reconnect cursors.** Protocol v1 has no per-session event sequence
   and no cursor to resume a stream from. A resurrected stream would present a hole as continuity,
   so reconnect during an active turn is disabled and the session is retired instead. Enabling
   resilient reconnect needs monotonically sequenced events plus a replay-from-cursor call.

2. **Permission requests that block before execution.** The SDK's permission event is informational
   and arrives without a mechanism to hold the call until Pylon answers. Supervised, auto-accept
   edits, and auto modes all need a request that suspends the tool until a decision is returned,
   with a fail-closed default on timeout or transport loss. Until then `executionPolicy` publishes
   `runtimeModes: ["full-access"]` with `enforcement: "none"`.

3. **Authoritative queued-input observation.** Steering and follow-up controls require reading the
   provider's own pending-input state, not Pylon's guess at it. Protocol v1 exposes no queue
   inspection, so Pylon cannot report counts, cannot clear pending input, and cannot distinguish an
   admitted follow-up from a dropped one.

4. **Compaction completion and cancellation state.** The `compacted` frame reports that compaction
   happened; it is not a completion receipt and carries no cancellation channel or terminal status.
   A context meter and manual compaction controls need start/terminal transitions, an abort path,
   and the authoritative automatic-compaction setting.

5. **Structured tool mutation and history data.** Tool frames carry display-oriented payloads
   without a stable structured description of what changed on disk. Diff review, per-tool file
   attribution, and history navigation need typed mutation records keyed to a stable call identity.

6. **Safe rollback mapping plus Pylon rollback compensation.** Conversation rollback is only correct
   when the provider's rollback point maps to a Pylon filesystem checkpoint. Protocol v1 offers
   neither addressable rollback targets nor a way to compensate a partially applied rollback, so
   `rollbackThread` refuses instead of pretending.

7. **No-tools structured generation.** Background helpers (commit messages, PR content, branch
   names, thread titles) need a run with the host tool surface disabled. SDK v1 cannot disable
   tools for a structured run, so a "write a commit message" request could edit the working tree.
   `JcodeTextGeneration` therefore fails with a typed unavailable error rather than routing to
   another provider.

8. **OAuth and account status plus switching.** Jcode owns its own logins and reports no account
   identity, auth state, or switching call. Pylon cannot show who is signed in, cannot surface an
   expired credential before a turn fails, and cannot offer in-app sign-in.

9. **Swarms, memory, skills, MCP, goals, schedules, and side-panel events.** None of these are
   projected. Each needs a public observation surface with stable identities before it can become a
   provider-neutral Pylon projection; several would also need mutation calls to be useful rather
   than merely visible.

10. **API-key secret-management UX.** Isolated instances need a way to hand Jcode credentials that
    does not put secrets into provider config on disk. This needs a defined credential-injection
    contract on the SDK side plus Pylon secret storage, redaction, and rotation before it is offered
    as a supported flow.

## What is already enforced

- Execution is `full-access` only, published as snapshot data. `ProviderService` rejects any other
  mode at both session-start paths; it names no driver.
- Unsupported optional adapter members are omitted rather than defined as always-failing stubs,
  because absence is this repo's established unsupported signal.
- Every unprojected capability group carries an explicit reason string, so clients explain the gap
  instead of interpreting provider errors.
- Native session ids, socket paths, and daemon identifiers terminate at the adapter boundary.

## Client presentation

Clients treat Jcode as an ordinary provider snapshot. Web and mobile read labels, icons, models,
and supported runtime modes from generic shared metadata, and mobile consumes the server snapshot
with no provider-host configuration of its own. See [providers.md](./providers.md) for the driver
and adapter boundaries.
