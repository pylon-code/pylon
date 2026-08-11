# Jcode Stream Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Jcode's authoritative `TextReplace` and `RetryRollback` semantics through the public SDK and Pylon so aborted provider output never remains visible as valid transcript or tool activity.

**Architecture:** Jcode adds two additive capability-gated public events that directly translate existing daemon events. Pylon consumes them at the adapter boundary, maps them into provider-neutral correction events, and appends compensating orchestration events whose projectors replace or remove invalid output without rewriting the durable event log.

**Tech Stack:** Rust, Tokio, Serde, TypeScript, Node test runner, Effect, Effect Schema, Pylon event-sourced orchestration, SQLite projections, Vite Plus/Vitest.

## Global Constraints

- Preserve `/Users/rynfar/.jcode/source/jcode` on `fix/meridian-cache-affinity`; do not modify, reset, rebase, or delete its two local commits.
- Create Jcode implementation work from `origin/master` in an isolated worktree and branch named `feat/harness-api-stream-corrections`.
- Jcode public changes are additive: `API_VERSION_MAJOR = 1`, `API_VERSION_MINOR = 1`, capability `stream_corrections`.
- Public event tags are exactly `text_replace` and `retry_rollback`.
- Pylon canonical event tags are exactly `content.replaced` and `turn.output-reset`.
- No Jcode native session IDs, socket paths, daemon IDs, or raw call IDs may enter Pylon contracts or projections.
- Do not commit an absolute `file:` dependency or a local SDK tarball to Pylon.
- Until npm publishes the typed SDK update, Pylon consumes the additive frames through `AnyApiEvent` and a capability-gated runtime decoder inside `JcodeSdkBridge`.
- Use the worktree-local `vp`: `export PATH="$PWD/node_modules/.bin:$PATH"` and verify `command -v vp` resolves below the Pylon worktree.
- Do not run repository-wide Pylon checks. Run only the focused tests, lint, formatting, and package typechecks listed below.
- Jcode runtime validation must use a private test socket and a PID captured at process creation. Never kill by name or pattern.
- GPT-5.6 performs implementation. Meridian OpenAI-compatible Claude Opus 5 performs independent design and code review. Never use Claude OAuth, Fable, or GPT-5.5.
- No push or pull request without explicit user instruction.

---

### Task 0: Create the isolated Jcode implementation worktree

**Files:**

- Create worktree directory: `/Users/rynfar/.jcode/worktrees/harness-api-stream-corrections`
- Preserve source checkout: `/Users/rynfar/.jcode/source/jcode`

**Interfaces:**

- Consumes: clean `origin/master` from the canonical Jcode repository.
- Produces: isolated branch `feat/harness-api-stream-corrections` for Tasks 1-4.

- [ ] **Step 1: Verify the protected checkout and fetch upstream**

```bash
cd /Users/rynfar/.jcode/source/jcode
git status --short
test "$(git branch --show-current)" = "fix/meridian-cache-affinity"
git fetch origin master
```

Expected: clean output from `git status --short`; current branch remains `fix/meridian-cache-affinity`.

- [ ] **Step 2: Create the isolated worktree**

```bash
git worktree add -b feat/harness-api-stream-corrections \
  /Users/rynfar/.jcode/worktrees/harness-api-stream-corrections \
  origin/master
cd /Users/rynfar/.jcode/worktrees/harness-api-stream-corrections
git status --short --branch
```

Expected: clean branch tracking the fetched `origin/master` commit.

- [ ] **Step 3: Run the focused baseline**

```bash
cargo test -p jcode-harness-api
cargo test -p jcode-harness-api-server translate
cd sdk/typescript
npm test
```

Expected: all selected tests pass before implementation.

---

### Task 1: Add the public Jcode correction event schemas and capability

**Files:**

- Modify: `crates/jcode-harness-api/src/events.rs`
- Modify: `crates/jcode-harness-api/src/lib.rs`
- Modify: `crates/jcode-harness-api/src/harness_api_tests/schema_snapshot.rs`
- Modify: `crates/jcode-harness-api-server/src/lib.rs`

**Interfaces:**

- Consumes: legacy semantics `TextReplace { text }` and `RetryRollback { attempt, max }`.
- Produces: `ApiEvent::TextReplace`, `ApiEvent::RetryRollback`, minor version `1`, and capability `stream_corrections`.

- [ ] **Step 1: Write failing schema snapshot tests**

Add assertions equivalent to:

```rust
assert_eq!(API_VERSION_MINOR, 1);
assert_eq!(
    serde_json::to_value(ApiEvent::TextReplace {
        session_id: "session-1".into(),
        text: "replacement".into(),
    })?,
    json!({"ev":"text_replace","session_id":"session-1","text":"replacement"}),
);
assert_eq!(
    serde_json::to_value(ApiEvent::RetryRollback {
        session_id: "session-1".into(),
        attempt: 2,
        max: 4,
    })?,
    json!({"ev":"retry_rollback","session_id":"session-1","attempt":2,"max":4}),
);
```

Add a server handshake assertion that `capabilities` contains `stream_corrections` exactly once.

- [ ] **Step 2: Run the tests and observe RED**

```bash
cargo test -p jcode-harness-api schema_snapshot
cargo test -p jcode-harness-api-server framing
```

Expected: compilation or assertion failure because the variants, minor version, and capability do not exist.

- [ ] **Step 3: Implement the minimal public schema**

Add to `ApiEvent`:

```rust
TextReplace { session_id: String, text: String },
RetryRollback { session_id: String, attempt: u32, max: u32 },
```

Set:

```rust
pub const API_VERSION_MINOR: u32 = 1;
```

Add `stream_corrections` beside `streaming` in the handshake capability list.

- [ ] **Step 4: Run GREEN and format**

```bash
cargo fmt --check
cargo test -p jcode-harness-api
cargo test -p jcode-harness-api-server framing
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/jcode-harness-api crates/jcode-harness-api-server/src/lib.rs
git commit -m "feat(api): advertise stream corrections"
```

---

### Task 2: Translate daemon correction events through the public bridge

**Files:**

- Modify: `crates/jcode-harness-api-server/src/translate.rs`
- Modify: `crates/jcode-harness-api-server/src/translate_tests.rs`

**Interfaces:**

- Consumes: legacy JSON events `text_replace` and `retry_rollback` on an attached bridge connection.
- Produces: validated public correction events stamped with the bridge's attached `session_id`.

- [ ] **Step 1: Write failing translation tests**

Cover these exact cases:

```rust
json!({"ev":"text_replace","text":"corrected"})
// -> ApiEvent::TextReplace { session_id: "session-1", text: "corrected" }

json!({"ev":"retry_rollback","attempt":2,"max":4})
// -> ApiEvent::RetryRollback { session_id: "session-1", attempt: 2, max: 4 }
```

Also assert that retry frames are dropped when `attempt == 0`, `max == 0`, `attempt > max`, either counter is fractional, or either counter is absent.

- [ ] **Step 2: Run RED**

```bash
cargo test -p jcode-harness-api-server translate_tests
```

Expected: valid events currently translate to an empty frame list.

- [ ] **Step 3: Implement strict translation**

Add match arms that use the bridge's existing `session(self)` helper. Use `as_u64`, `u32::try_from`, and explicit `attempt > 0 && max > 0 && attempt <= max` checks. Return `vec![]` on malformed input.

- [ ] **Step 4: Run GREEN**

```bash
cargo fmt --check
cargo test -p jcode-harness-api-server translate_tests
cargo test -p jcode-harness-api-server
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/jcode-harness-api-server/src/translate.rs \
  crates/jcode-harness-api-server/src/translate_tests.rs
git commit -m "feat(api): forward stream corrections"
```

---

### Task 3: Update the TypeScript and Rust SDK parity surfaces

**Files:**

- Modify: `sdk/typescript/src/protocol.ts`
- Modify: `sdk/typescript/test/schema-parity.test.ts`
- Modify: `sdk/typescript/test/client.test.ts`
- Modify: `crates/jcode-sdk/src/sdk_tests/parity.rs`

**Interfaces:**

- Consumes: public `text_replace` and `retry_rollback` frames.
- Produces: narrowed typed `ApiEvent` members and complete known-event parity.

- [ ] **Step 1: Write failing parity and iterator tests**

Assert:

```ts
assert.equal(isKnownEvent({ ev: "text_replace", session_id: "s", text: "x" }), true);
assert.equal(isKnownEvent({ ev: "retry_rollback", session_id: "s", attempt: 1, max: 3 }), true);
```

Using `mock-harness.ts`, emit both frames and assert `client.events("s")` yields them with their typed fields unchanged and in order. Add explicit source-parity assertions that the TypeScript known-event list and Rust `ApiEvent` source both contain `text_replace` and `retry_rollback`.

- [ ] **Step 2: Run RED**

```bash
cd sdk/typescript
npm test
```

Expected: the new tags are not in `ApiEvent` or `KNOWN_EVENT_KINDS`.

- [ ] **Step 3: Add the two union members and known tags**

```ts
| { ev: "text_replace"; session_id: string; text: string }
| { ev: "retry_rollback"; session_id: string; attempt: number; max: number }
```

Add both strings immediately after `text_delta` in `KNOWN_EVENT_KINDS` in protocol order.

- [ ] **Step 4: Run GREEN and Rust parity**

```bash
npm run check
cd ../..
cargo test -p jcode-sdk parity
```

Expected: TypeScript checks and Rust parity tests pass.

- [ ] **Step 5: Commit**

```bash
git add sdk/typescript crates/jcode-sdk/src/sdk_tests/parity.rs
git commit -m "feat(sdk): type stream correction events"
```

---

### Task 4: Prove the Jcode public boundary in an isolated runtime

**Files:**

- Modify or create focused integration coverage beside: `crates/jcode-harness-api-server/src/framing_tests.rs`
- Modify: `sdk/typescript/test/live-capabilities.mjs`

**Interfaces:**

- Consumes: built selfdev Jcode binary and private socket.
- Produces: evidence that the live handshake advertises `stream_corrections` and the actual socket bridge preserves correction frames.

- [ ] **Step 1: Add a socket-level fake-legacy integration test**

Start a private legacy listener in the test, attach the public bridge, emit a valid `text_replace` followed by `retry_rollback`, and assert the public NDJSON client receives both in order with the attached session ID. This test must cross the real framing and `handle_api_client` loop rather than calling `BridgeState` directly.

- [ ] **Step 2: Run the socket test RED, then GREEN**

```bash
cargo test -p jcode-harness-api-server framing_tests -- --nocapture
```

Expected before implementation: no public correction frames. Expected after implementation: both frames arrive in order.

- [ ] **Step 3: Build the real selfdev binary**

```bash
cargo build --profile selfdev -p jcode
```

Expected: `target/selfdev/jcode` exists.

- [ ] **Step 4: Start and probe a private real daemon**

```bash
SCRATCH="${JCODE_SCRATCH_DIR:-$HOME/.jcode/scratch}/stream-corrections"
mkdir -p "$SCRATCH"
SOCKET="$SCRATCH/jcode.sock"
API_SOCKET="$SCRATCH/jcode-api.sock"
rm -f "$SOCKET" "$API_SOCKET"
JCODE_RUNTIME_DIR="$SCRATCH" JCODE_SOCKET="$SOCKET" \
  ./target/selfdev/jcode run --no-update --socket "$SOCKET" >"$SCRATCH/daemon.log" 2>&1 &
DAEMON_PID=$!
trap 'kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do test -S "$API_SOCKET" && break; sleep 0.1; done
test -S "$API_SOCKET"
cd sdk/typescript
npm run build
JCODE_API_SOCKET="$API_SOCKET" node test/live-capabilities.mjs
```

Extend the live script's initial assertions so `client.supports("stream_corrections")` must be true. Read the output and daemon log; do not rely only on the exit code.

- [ ] **Step 5: Commit runtime coverage**

```bash
git add crates/jcode-harness-api-server/src/framing_tests.rs \
  sdk/typescript/test/live-capabilities.mjs
git commit -m "test(api): verify live stream corrections"
```

---

### Task 5: Add provider-neutral Pylon correction contracts

**Files:**

- Modify: `packages/contracts/src/providerRuntime.ts`
- Modify: `packages/contracts/src/providerRuntime.test.ts` or the nearest existing provider-runtime schema suite

**Interfaces:**

- Produces:
  - `content.replaced` with assistant stream kind and complete text
  - `turn.output-reset` with `provider_retry`, positive attempt, and positive max

- [ ] **Step 1: Write failing schema round-trip tests**

Use branded `eventId`, `threadId`, `turnId`, and `itemId` fixtures. Assert valid events decode and these invalid events fail: missing `turnId`, non-string replacement text, zero attempt, zero max, and `attempt > max`. An empty replacement string is valid because Jcode may authoritatively clear the current stream.

- [ ] **Step 2: Run RED**

```bash
cd /Users/rynfar/repos/pylon/.prime/worktrees/prime-agent-integration
export PATH="$PWD/node_modules/.bin:$PATH"
test "$(command -v vp)" = "$PWD/node_modules/.bin/vp"
vp test run packages/contracts/src/providerRuntime.test.ts
```

Expected: new event tags are rejected.

- [ ] **Step 3: Implement schemas**

Add both tags to `ProviderRuntimeEventType`, add literal constants, payload schemas, event structs, and union members. Add a schema-level refinement for `attempt <= max`.

- [ ] **Step 4: Run GREEN and typecheck**

```bash
vp test run packages/contracts/src/providerRuntime.test.ts
vp run -F @t3tools/contracts typecheck
```

Expected: tests and contract typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/providerRuntime.ts packages/contracts/src/providerRuntime.test.ts
git commit -m "feat(contracts): add stream correction events"
```

---

### Task 6: Decode correction frames and map them in the Jcode adapter

**Files:**

- Modify: `apps/server/src/provider/jcode/JcodeSdkBridge.ts`
- Modify: `apps/server/src/provider/jcode/JcodeSdkBridge.test.ts`
- Modify: `apps/server/src/provider/jcode/JcodeRuntimeEvents.ts`
- Modify: `apps/server/src/provider/jcode/JcodeRuntimeEvents.test.ts`
- Modify: `apps/server/src/provider/jcode/JcodeSessionRuntime.test.ts`

**Interfaces:**

- Consumes: `AnyApiEvent` plus capability `stream_corrections`.
- Produces: validated correction events for the mapper, then canonical `content.replaced`, `turn.output-reset`, and retry lifecycle events.

- [ ] **Step 1: Write failing bridge-decoder tests**

Assert the decoder accepts exact valid shapes only when `stream_corrections` is advertised and rejects missing IDs, wrong scalar types, zero/descending counters, or events without the capability.

- [ ] **Step 2: Write failing mapper tests**

Cover:

1. `text_replace` starts an assistant item when necessary, emits `content.replaced`, and keeps it open.
2. A later `text_delta` appends after the replacement.
3. `retry_rollback` emits `turn.output-reset` before retry `item.started`.
4. Reset clears open tool, assistant, and reasoning state, advances `segment`, and preserves tasks/model.
5. Missing `turnId` is fatal.
6. Replacement text obeys `MAX_TEXT_LENGTH`.

- [ ] **Step 3: Run RED**

```bash
vp test run \
  apps/server/src/provider/jcode/JcodeSdkBridge.test.ts \
  apps/server/src/provider/jcode/JcodeRuntimeEvents.test.ts \
  apps/server/src/provider/jcode/JcodeSessionRuntime.test.ts
```

Expected: new frames are ignored or unavailable.

- [ ] **Step 4: Implement the boundary and mapper**

Change `JcodeSdkClientLike.events` to return `AsyncIterableIterator<AnyApiEvent>`. Add a pure decoder returning `ApiEvent | JcodeStreamCorrectionEvent | undefined`; existing known events still use `isKnownEvent`.

Extend mapper state with `attemptGeneration: number`. Include it in assistant, reasoning, and tool item identities. Increment it on each retry reset so the fresh sample cannot collide with invalidated attempt items. Emit reset before retry lifecycle and clear only attempt-local state.

- [ ] **Step 5: Run GREEN, lint, and typecheck**

```bash
vp test run \
  apps/server/src/provider/jcode/JcodeSdkBridge.test.ts \
  apps/server/src/provider/jcode/JcodeRuntimeEvents.test.ts \
  apps/server/src/provider/jcode/JcodeSessionRuntime.test.ts
vp lint apps/server/src/provider/jcode/JcodeSdkBridge.ts \
  apps/server/src/provider/jcode/JcodeRuntimeEvents.ts
vp run -F t3 typecheck
```

Expected: all focused tests pass and typecheck has no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/provider/jcode
git commit -m "feat(server): map Jcode stream corrections"
```

---

### Task 7: Add compensating orchestration commands and projectors

**Files:**

- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `apps/server/src/orchestration/decider.ts`
- Modify: `apps/server/src/orchestration/projector.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- Modify focused tests: `apps/server/src/orchestration/projector.test.ts`
- Modify focused tests: `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`
- Create: `apps/server/src/orchestration/decider.streamCorrection.test.ts`

**Interfaces:**

- Produces internal commands `thread.message.assistant.replace`, `thread.turn.output.reset`.
- Produces durable events `thread.message-replaced`, `thread.turn-output-reset`.

- [ ] **Step 1: Write failing command/decider tests**

Assert replacement emits `thread.message-replaced` with `streaming: true`. Assert reset requires the thread and matching active turn, and emits retry counters unchanged.

- [ ] **Step 2: Write failing projector tests**

Build a thread containing:

- one user message for turn A
- two assistant messages for turn A
- provider activities for turn A
- one assistant message/activity for turn B

After `thread.turn-output-reset` for turn A, assert the user message and all turn B rows remain while turn A assistant messages and activities are gone. Apply the reset twice and assert the same result.

Assert `thread.message-replaced` replaces, rather than appends, and remains streaming.

- [ ] **Step 3: Run RED**

```bash
vp test run \
  apps/server/src/orchestration/projector.test.ts \
  apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts \
  apps/server/src/orchestration/decider.streamCorrection.test.ts
```

Expected: command and event tags do not exist.

- [ ] **Step 4: Implement contracts and decider**

Add the two internal commands and two orchestration event schemas. Keep them out of `ClientOrchestrationCommand`. The decider validates the active turn for reset and creates append-only compensating events.

- [ ] **Step 5: Implement pure and persistence projections**

For replacement, assign the replacement text directly while retaining `streaming: true`.

For reset, filter assistant messages and activities by `turnId`. In `ProjectionPipeline`, mirror the existing `thread.reverted` list-filter-delete-reinsert pattern for message and activity repositories, then refresh the shell summary.

- [ ] **Step 6: Run GREEN and typechecks**

```bash
vp test run \
  apps/server/src/orchestration/projector.test.ts \
  apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts \
  apps/server/src/orchestration/decider.streamCorrection.test.ts
vp run -F @t3tools/contracts typecheck
vp run -F t3 typecheck
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/orchestration.ts apps/server/src/orchestration
git commit -m "feat(server): compensate aborted provider output"
```

---

### Task 8: Integrate corrections into ProviderRuntimeIngestion

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`

**Interfaces:**

- Consumes: canonical `content.replaced` and `turn.output-reset`.
- Produces: replacement/reset orchestration commands and cleared per-turn caches.

- [ ] **Step 1: Write failing streaming and buffered tests**

Streaming mode sequence:

```text
content.delta("wrong")
content.replaced("correct")
content.delta(" answer")
```

Expected projected text: `correct answer`, still streaming until item/turn completion.

Buffered mode uses the same sequence and must produce exactly `correct answer` at completion without first publishing `wrong`.

- [ ] **Step 2: Write failing retry compensation test**

Emit assistant/tool output, then `turn.output-reset`, then fresh output. Assert invalid messages/activities disappear, caches do not spill old text, and only the fresh attempt remains plus the retry activity.

- [ ] **Step 3: Run RED**

```bash
vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
```

Expected: replacement appends and reset does not compensate.

- [ ] **Step 4: Implement ingestion**

Add `replaceBufferedAssistantText`. On `content.replaced`, resolve the current assistant message and either replace the buffer or dispatch `thread.message.assistant.replace`.

On `turn.output-reset`, clear buffered text for every remembered assistant message, invalidate assistant message/segment caches, then dispatch `thread.turn.output.reset`. Preserve turn/session lifecycle.

- [ ] **Step 5: Run GREEN, lint, and typecheck**

```bash
vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
vp lint apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
vp run -F t3 typecheck
```

Expected: focused suite passes without new diagnostics.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts \
  apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
git commit -m "feat(server): ingest provider stream corrections"
```

---

### Task 9: Update compatibility documentation and run deterministic verification

**Files:**

- Modify: `docs/internals/jcode-sdk-compatibility.md`
- Modify: `docs/internals/jcode-sdk-blockers.md`
- Modify if user-visible behavior warrants it: `docs/user/providers-jcode.md`

**Interfaces:**

- Produces: accurate shipped/local capability record and a complete deterministic evidence bundle.

- [ ] **Step 1: Update docs**

Record the local Jcode commit SHA, API minor `1`, capability `stream_corrections`, the temporary Pylon `AnyApiEvent` compatibility decoder, and the cleanup condition: published SDK release containing both typed events.

- [ ] **Step 2: Run the complete focused Jcode verification**

```bash
cd /Users/rynfar/.jcode/worktrees/harness-api-stream-corrections
cargo fmt --check
cargo test -p jcode-harness-api
cargo test -p jcode-harness-api-server
cargo test -p jcode-sdk parity
cd sdk/typescript
npm run check
```

Read test counts and failures from output.

- [ ] **Step 3: Run the complete focused Pylon verification**

```bash
cd /Users/rynfar/repos/pylon/.prime/worktrees/prime-agent-integration
export PATH="$PWD/node_modules/.bin:$PATH"
vp test run \
  packages/contracts/src/providerRuntime.test.ts \
  apps/server/src/provider/jcode/JcodeSdkBridge.test.ts \
  apps/server/src/provider/jcode/JcodeRuntimeEvents.test.ts \
  apps/server/src/provider/jcode/JcodeSessionRuntime.test.ts \
  apps/server/src/orchestration/projector.test.ts \
  apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts \
  apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
vp run -F @t3tools/contracts typecheck
vp run -F t3 typecheck
```

Expected: every selected suite passes and typechecks report no errors.

- [ ] **Step 4: Commit docs**

```bash
git add docs/internals/jcode-sdk-compatibility.md \
  docs/internals/jcode-sdk-blockers.md docs/user/providers-jcode.md
git commit -m "docs(jcode): record stream correction support"
```

---

### Task 10: Run independent Meridian Opus 5 review and fix findings

**Files:**

- Review every commit created by Tasks 1-9.
- Modify only files required by verified findings.

**Interfaces:**

- Consumes: complete deterministic implementation and evidence.
- Produces: independent architecture/code verdict and corrected implementation.

- [ ] **Step 1: Dispatch a fresh review-only Opus 5 worker**

Use exact route `openai-compatible:meridian-anthropic:claude-opus-5`. Ask it to verify:

- additive public API compatibility
- public capability and event naming
- malformed frame handling
- mapper lifecycle invariants and item identity after reset
- orchestration append-only compensation
- streaming and buffered replacement semantics
- idempotence and replay ordering
- native identity isolation
- test quality and missing failure paths

- [ ] **Step 2: Triage every finding against source**

For each finding, record `confirmed`, `false positive`, or `deferred with reason`. Do not implement speculative redesign.

- [ ] **Step 3: Fix confirmed findings test-first**

Add a failing focused regression, observe RED, implement the minimal correction, and observe GREEN.

- [ ] **Step 4: Re-run Task 9 verification**

Expected: all deterministic gates pass after fixes.

- [ ] **Step 5: Commit review fixes by concern**

Use conventional commit titles scoped to `api`, `sdk`, `contracts`, or `server`. Do not squash unrelated Jcode and Pylon history together.

---

### Task 11: Integrated acceptance and upstream handoff preparation

**Files:**

- No required code changes unless acceptance finds a defect.
- Produce review notes from git history and validation output.

**Interfaces:**

- Produces: proven local Pylon behavior and an upstream-ready Jcode proposal.

- [ ] **Step 1: Ask permission for real-client computer use**

The repository requires explicit permission before browser, desktop, or simulator verification. Do not launch them without it.

- [ ] **Step 2: Run image and correction acceptance**

With permission, verify in web/desktop and mobile:

1. image-only Jcode message
2. text plus image Jcode message
3. normal assistant streaming
4. forced text replacement
5. forced retry rollback with no stale text or tool rows
6. fresh output continues after correction

- [ ] **Step 3: Prepare the Jcode upstream proposal**

The Jcode proposal contains only the Jcode worktree commits. Its description states the corruption scenario, minimal reproduction, additive protocol shape, capability gate, compatibility behavior, and test evidence. End with the model and harness used.

- [ ] **Step 4: Stop before push or PR**

Report branch names, SHAs, verification, Opus verdict, and remaining limitations. Wait for explicit user instruction before adding a personal fork remote, pushing, or opening a pull request.
