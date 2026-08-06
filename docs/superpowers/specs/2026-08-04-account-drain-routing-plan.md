# Plan — Phase B: account drain state and new-thread routing

Branch: `feat/2026-08-04-account-drain-routing` (off `upstream/2026-08-04-provider-usage-limits`)

Design context: `2026-08-04-multi-account-claude-design.md`.

## Key architectural finding

The drain ledger does **not** need a new service. `ProviderRegistry` already models exactly
this shape — volatile, per-instance, snapshot-projected, change-streamed:

- `setProviderMaintenanceActionState` applies volatile per-instance state that is never
  persisted and is projected onto `ServerProvider.updateState`. Its own doc comment invites
  extension: _"install/auth actions can extend this action map without adding driver-scoped APIs."_
- `streamChanges` already pushes full snapshot arrays to every connected client.

So rate-limit state follows `updateState`'s path exactly. This removes an entire service, a
persistence decision, and a push mechanism from the phase.

## Slices

Each slice is independently committable and leaves the tree green.

### B1 — contract

`packages/contracts/src/server.ts`: add `ServerProviderRateLimit` and an optional
`rateLimit` field on `ServerProvider`, alongside `usageLimits`.

```
ServerProviderRateLimit {
  status: "allowed" | "allowed_warning" | "rejected"
  rateLimitType?: string        // five_hour | seven_day | seven_day_opus | ...
  resetsAt?: IsoDateTime
  observedAt: IsoDateTime
}
```

Optional and additive, so older clients decoding a newer snapshot are unaffected — and the
forward-compat decode from upstream A6 already drops unknown members rather than failing the
array.

Tests: decode with and without the field; unknown `status` member does not fail the snapshot.

### B2 — instance priority

`packages/contracts/src/providerInstance.ts`: add `priority?: number` to
`ProviderInstanceConfig`. Lower sorts first. Absent means "after everything explicitly
ordered", so existing configs keep working untouched.

A single derived helper (contracts, per the "small derived helpers" boundary) orders instances:
explicit priority first, then existing order.

Tests: ordering with all/partial/no priorities set.

### B3 — registry state

`ProviderRegistry.setProviderRateLimitState({ instanceId, state })`, mirroring
`setProviderMaintenanceActionState`. Volatile, projected onto the snapshot, emits on
`streamChanges`.

Tests: setting state projects onto the snapshot; clearing restores; unknown instance is a
no-op returning the current list (matching `refreshInstance`'s established behavior).

### B4 — ingestion wiring

In `orchestration/Layers/ProviderRuntimeIngestion.ts`, handle
`account.rate-limits.updated` — currently emitted by `ClaudeAdapter` and `CodexAdapter` and
consumed by nothing — by mapping its payload onto the registry state.

The payload is `Schema.Unknown` at the contract layer by design (drivers own their shapes), so
parsing belongs at the adapter boundary. Decode defensively and fail closed: an unrecognized
shape leaves state untouched rather than throwing.

Tests: a `rejected` event marks the instance drained; a malformed payload is ignored; drain
state clears when a later event reports `allowed`.

### B5 — client routing

`apps/web/src/components/chat/ChatComposer.tsx` already resolves a selectable instance through
`resolveSelectableProviderInstanceEntry`. Extend that resolution to skip instances whose
`rateLimit.status` is `rejected` and whose `resetsAt` is still in the future, preferring
priority order.

Existing threads keep their bound instance — routing applies to new threads only. The per-thread
Auto/Pinned control stays authoritative.

Tests: routing picks the highest-priority healthy instance; skips a drained one; falls back to
the drained one when every instance is drained (better to attempt and surface the real error
than to block the composer).

### B6 — drain pill

A conditional pill in the `SidebarChromeFooter` stack beside `SidebarProviderUpdatePill`.
Renders only when an instance is drained. States which account took over and when the drained
one resets. Coarse relative time on a one-minute tick — never a per-second countdown.

Tests: renders nothing when healthy; renders on drain; no animation at rest.

## Explicit non-goals for this phase

- Mid-thread switching. A running thread stays on its instance; that is Phase C.
- Mobile surfaces. Deferred with the rest of Phase A's mobile work.
- Persisting drain state across restarts. It is volatile by design; a restart re-learns it from
  the next turn, and `resetsAt` bounds the staleness.
- Grok / Cursor / OpenCode. `account.rate-limits.updated` is emitted only by the Claude and
  Codex adapters today. Recorded as **not supported** for the other three rather than silently
  omitted.

## Verification

Focused `vp test run` per slice, plus targeted lint and typecheck of touched packages. Contracts
change is a wire contract, so typecheck contracts, server, and web together after B1.
