# Jcode Stream Integrity Design

Date: 2026-08-11
Status: approved for implementation

## Problem

Jcode's internal daemon can correct a live provider stream in two ways that the public harness API currently drops:

- `TextReplace { text }` replaces the assistant text accumulated for the current streaming segment.
- `RetryRollback { attempt, max }` means a transport failure interrupted the provider response and Jcode is retrying from the beginning with a fresh sample. Every partial assistant segment and tool row from the aborted attempt is invalid.

Jcode's TUI applies both corrections. Public API clients only receive deltas, tool lifecycle events, and turn completion. A client such as Pylon can therefore retain text or tool rows that Jcode itself discarded, producing duplicated or contradictory output.

This is a correctness defect at the public facade, not a Pylon presentation preference.

## Goals

1. Expose both stream-correction signals through the stable Jcode harness API and TypeScript SDK.
2. Preserve Jcode's curated additive API design and unknown-event forward compatibility.
3. Map corrections into provider-neutral Pylon runtime events.
4. Compensate Pylon's event-sourced projections without deleting durable domain history.
5. Keep assistant streaming responsive in both Pylon streaming and buffered delivery modes.
6. Prove the behavior with focused schema, translation, mapper, ingestion, projector, and live-runtime tests.
7. Produce a focused upstream-ready Jcode commit that does not depend on Pylon.

## Non-goals

- Event sequence numbers or reconnect replay. Those are the next reliability slice.
- Input steering or queue observation. Those follow replay and are independently reviewable.
- Permission enforcement, structured history, rollback checkpoints, or compaction lifecycle.
- A Jcode-specific client contract or UI state in Pylon.
- Changing image input. Images already cross Pylon, the Jcode SDK, and the harness API and only need live acceptance coverage.

## Delivery strategy

The work is split into two independently testable commits and review boundaries:

1. **Jcode public API and SDK:** expose the daemon's existing correction semantics without changing them.
2. **Pylon compensation:** consume the new public events and apply provider-neutral corrections to projections.

Jcode development starts from `origin/master` in an isolated worktree. The existing local branch `fix/meridian-cache-affinity` and its two Meridian runtime commits remain untouched. Nothing is pushed without explicit user instruction.

## Jcode public API

### Capability

Add `stream_corrections` to `HelloOk.capabilities`. Clients must not assume either correction event is available unless the capability is present.

The change is additive. Increment `API_VERSION_MINOR` from `0` to `1`; keep `API_VERSION_MAJOR` at `1`.

### Events

Add two `ApiEvent` variants:

```rust
TextReplace {
    session_id: String,
    text: String,
},
RetryRollback {
    session_id: String,
    attempt: u32,
    max: u32,
},
```

The TypeScript SDK exposes matching discriminated-union members:

```ts
| { ev: "text_replace"; session_id: string; text: string }
| { ev: "retry_rollback"; session_id: string; attempt: number; max: number }
```

Both tags are added to `KNOWN_EVENT_KINDS`. Unknown-event behavior remains unchanged for older clients.

### Translation

`BridgeState::legacy_event_to_api` maps:

- legacy `text_replace.text` to `ApiEvent::TextReplace`
- legacy `retry_rollback.attempt/max` to `ApiEvent::RetryRollback`

The bridge stamps the attached public `session_id`; it does not expose a legacy/native session identifier.

Malformed correction events are dropped rather than synthesized. In particular, `retry_rollback` requires integer `attempt` and `max`, both greater than zero, and `attempt <= max`. The internal daemon currently emits valid values; validation protects the stable facade from malformed legacy traffic.

## Pylon provider runtime contract

Add two provider-neutral event types.

### `content.replaced`

```ts
{
  type: "content.replaced";
  itemId: RuntimeItemId;
  turnId: TurnId;
  payload: {
    streamKind: "assistant_text";
    text: string;
  }
}
```

This means the complete current content for the identified live stream is now `text`. It is not a delta and does not complete the item.

### `turn.output-reset`

```ts
{
  type: "turn.output-reset";
  turnId: TurnId;
  payload: {
    reason: "provider_retry";
    attempt: PositiveInt;
    max: PositiveInt;
  }
}
```

This invalidates provider-produced assistant messages and activity rows for the turn before the reset event. It preserves the user message, turn identity, checkpoint state, and durable event log.

The generic contract allows another adapter to consume equivalent provider retry semantics later. No Jcode-native fields cross the adapter boundary.

## Jcode mapper behavior in Pylon

### Text replacement

On `text_replace`:

1. Start the assistant item first if no assistant item is active.
2. Emit `content.replaced` for the current assistant item.
3. Preserve all tool and reasoning state.
4. Keep the assistant item open for later deltas or completion.
5. Bound replacement text using the same canonical text limit as deltas.

### Retry rollback

On `retry_rollback`:

1. Emit `turn.output-reset` with the validated attempt counters.
2. Emit a canonical retry lifecycle row so the user sees that Jcode is retrying.
3. Clear `assistantStarted`, `reasoningStarted`, and `openTools` from mapper state.
4. Advance the mapper segment so the fresh sample uses new assistant and reasoning item identities.
5. Preserve background-task state and current-model state because those are session-level, not aborted provider output.

The reset event is the explicit terminal compensation for invalidated open items. The mapper must not invent `item.completed` rows for tool calls that Jcode declared nonexistent.

A retry event without a Pylon `turnId` is fatal. Pylon cannot safely choose which output to invalidate without an authoritative turn boundary.

## Pylon orchestration compensation

### Text replacement

Add internal command `thread.message.assistant.replace` and durable event `thread.message-replaced`.

The command/event carries `threadId`, `messageId`, `text`, optional `turnId`, `streaming`, and timestamps. Projectors replace the message text rather than append it while leaving the message in streaming state.

Provider ingestion handles delivery modes separately:

- **Streaming mode:** dispatch `thread.message.assistant.replace` immediately.
- **Buffered mode:** replace the server-side buffered assistant text. Do not publish an intermediate message until normal spill or completion logic requires it.

### Turn output reset

Add internal command `thread.turn.output.reset` and durable event `thread.turn-output-reset`.

The decider requires the thread and an active matching turn. The event carries the turn ID and retry counters.

Projectors apply compensation in order:

1. Remove assistant messages whose `turnId` matches the reset turn.
2. Remove projected activity rows whose `turnId` matches the reset turn.
3. Preserve the user message and the turn itself.
4. Refresh thread summaries.
5. Keep the append-only orchestration event log unchanged.

Provider ingestion also clears its per-turn assistant IDs, active segment state, and buffered text before processing the subsequent retry lifecycle and fresh deltas.

Because reset is rare and correctness-sensitive, persistence projectors may mirror the existing `thread.reverted` list-filter-rewrite pattern instead of adding new repository APIs.

## Ordering

For one retry, canonical order is:

1. `turn.output-reset`
2. retry `item.started`
3. fresh assistant/tool events

For text replacement, `content.replaced` occupies the exact stream position where the legacy event arrived. Later deltas append to the replacement.

Future sequence/replay work will sequence both correction events like every other session event. This design does not introduce a second ordering mechanism.

## Failure handling

- A Jcode correction event for another native session remains filtered by the existing session runtime.
- Malformed public correction frames are rejected by SDK/runtime validation or ignored as unknown traffic according to the existing boundary.
- `text_replace` without an active Pylon turn is fatal because replacement cannot be attributed safely.
- `retry_rollback` without an active Pylon turn is fatal.
- Projection compensation is idempotent. Replaying the same reset leaves no invalid output and preserves the next sample if ordering is respected.
- No native Jcode session IDs, sockets, call IDs, or credential data are added to Pylon events.

## Testing

### Jcode

- Schema snapshots cover both serialized event shapes and the minor-version bump.
- Bridge translation tests cover valid events, attached-session stamping, malformed counters, and unrelated-event dropping.
- Rust/TypeScript parity tests prove both SDKs know the same event tags.
- TypeScript client tests prove correction events are yielded as known typed events.
- An isolated selfdev daemon test forces or fixtures a retry path and observes correction events through the public socket.

### Pylon contracts and mapper

- Contract round trips cover `content.replaced` and `turn.output-reset`.
- Mapper tests cover start-before-replace, replacement followed by delta, reset ordering, tool-state clearing, segment advancement, bounded text, and missing-turn fatal behavior.
- Session-runtime tests prove the new SDK events reach the mapper and remain session-filtered.

### Pylon orchestration and projection

- Ingestion tests cover streaming replacement, buffered replacement, reset compensation, fresh output after reset, and idempotent duplicate reset.
- Decider tests pin thread/turn validation.
- Pure projector and persistence pipeline tests prove matching assistant messages and activities disappear while user messages and unrelated turns remain.
- Web and mobile need no provider-specific implementation if generic projections update correctly; integrated acceptance verifies both surfaces when browser/simulator permission is granted.

## Review gates

1. GPT-5.6 implements each repository slice test-first.
2. The coordinator runs focused tests, formatting, lint, and typechecks and reads their output.
3. Meridian-routed Claude Opus 5 independently reviews architecture, compatibility, lifecycle ordering, and test quality.
4. Findings are fixed and re-verified before any upstream submission.
5. The Jcode commit remains focused and Pylon-independent.

## Follow-on slices

After stream integrity is proven:

1. sequenced events and replay cursors
2. authoritative steering and input queue controls
3. blocking permission decisions
4. structured history and tool mutations
5. safe provider/Pylon rollback mapping
6. no-tools generation and compaction lifecycle
7. auth, account, secrets, resources, MCP, skills, prompts, commands, telemetry
8. swarms, memory, goals, schedules, and other useful native surfaces
