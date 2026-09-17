# ACP prompt liveness and truthful forced stops

Date: 2026-09-17. Status: approved design, pending implementation.

## Problem

On 2026-09-17 thread `8f2cec4b` (Antigravity, `gemini-3.8-flash-high`) streamed
its final assistant message at 18:00:28Z and then received nothing from the
Antigravity ACP server for 27 minutes. The agent's own trajectory store recorded
the turn as finished, but the server never wrote the `session/prompt` JSON-RPC
response. Pylon only settles a turn on that response, so the thread stayed
"running" with a finished answer on screen. The same signature appears in five
Antigravity threads that day, lasting 27 minutes to 4.5 hours each. No other
provider shows it.

Pressing Stop then did three things badly:

1. `AcpSessionRuntime.cancel` with `cancelBehavior: "wait-for-prompt"` sent
   `session/cancel`, waited the 15 s `cancelTimeout`, force-killed the child
   process (correct), and then **failed** with an `AcpTransportError`. The stop
   had succeeded; it was reported as a failure.
2. `AcpTransportError.message` renders only operation and method. The
   `detail` ("The ACP agent did not finish cancellation. Its process was
   stopped.") was dropped, so the user saw
   "ACP transport operation call-rpc failed for method session/cancel."
3. The Antigravity adapter emitted **no terminal `turn.completed`** for the
   hung turn. The session was only cleaned up because
   `ProviderCommandReactor.processTurnInterruptRequested` falls back to
   `providerService.stopSession` after an interrupt error. Follow-up Stop
   clicks queued behind the first and each failed with "No active provider
   session is bound to this thread."

Upstream T3 (`pingdotgg/t3code` main at `4749035bda`, 2026-09-17) has the same
runtime, same cancel timeout, same error getter, and no stalled-prompt handling.
Nothing to adopt.

## Goals

- A prompt whose agent process has gone silent, with nothing pending on either
  side, settles as a **failed** turn with an explicit reason and the process is
  retired. Opt-in per adapter; Antigravity first.
- A forced stop after `cancelTimeout` is a **successful** cancel. The turn
  settles as **cancelled** with an `errorMessage` that says the process was
  force-stopped. No reactor fallback is needed on the normal path.
- Every retirement reason reaches the user: in the turn's `errorMessage`, the
  session's `lastError`, and the transport error's `message`.
- The last lines of agent stderr are preserved in the retirement reason so agent
  hangs can be diagnosed after the fact.

## Non-goals

- Fixing the Antigravity ACP server bug itself. That is an upstream report to
  Google (see Rollout).
- A provider-agnostic "quiet turn" indicator in orchestration. Deferred; the
  runtime rule below is the only auto-kill and it is deliberately narrow.
- Changing Cursor, Grok, or Prime ACP behavior. They keep
  `cancelBehavior: "interrupt"` and do not opt into liveness.
- New wire contracts. Existing `turn.completed`, `session.exited`, and activity
  payloads carry everything.

## Design

### 1. Prompt liveness rule in `AcpSessionRuntime`

File: `apps/server/src/provider/acp/AcpSessionRuntime.ts`.

New option on `AcpSessionRuntimeOptions`:

```ts
/**
 * Retire the process when a prompt is outstanding and the agent has been
 * silent for this long with no tool call in progress and no agent→client
 * request in flight. Undefined disables the rule.
 */
readonly promptInactivityTimeout?: Duration.Input;
```

State the runtime already holds and reuses:

- `activePromptRef` — Some while a `session/prompt` RPC is outstanding.
- `toolCallsRef` — tool calls not yet `completed`/`failed`.

State added:

- `lastAgentActivityRef: Ref<number>` (epoch ms). Set on every notification that
  passes the `handleSessionUpdate` gate (after the termination and discard
  checks, before the replay check so replays also count as life), and on entry
  to every agent→client request handler.
- `inflightClientRequestsRef: Ref<number>`. The runtime wraps the handlers it
  registers with the ACP client (`handleRequestPermission`, `handleElicitation`,
  `handleReadTextFile`, `handleWriteTextFile`, `handleCreateTerminal`,
  `handleTerminalOutput`, `handleTerminalWaitForExit`, `handleTerminalKill`,
  `handleTerminalRelease`, `handleUnknownExtRequest`, `handleExtRequest`) so
  the count increments on entry and decrements in `Effect.ensuring`. The
  wrapped handler is what the adapter's registration installs; adapters do not
  change.

Watchdog: when `promptInactivityTimeout` is set, `prompt` forks one watchdog
fiber into `runtimeScope` right after the prompt fiber is registered as active.
The watchdog loops:

1. Read `lastAgentActivityRef`; sleep until `last + timeout`.
2. On wake, re-read. If activity moved, loop.
3. If the prompt is no longer the active prompt, exit.
4. If `toolCallsRef` is non-empty or `inflightClientRequestsRef > 0`, treat now
   as activity and loop (a running tool or a pending approval is not silence).
5. Otherwise call `retireRuntime` with:

   ```ts
   new AcpTransportError({
     operation: "call-rpc",
     method: "session/prompt",
     detail: `The agent sent nothing for ${minutes} minutes after its last message and never completed the prompt. Its process was stopped.${stderrTail}`,
     cause: undefined,
   })
   ```

The watchdog is interrupted in the prompt's release step alongside the prompt
fiber. Time comes from `Clock` so tests use `TestClock`.

`retireRuntime` already calls `recordTermination`, which closes the active
assistant segment and enqueues `{ _tag: "ConnectionTerminated", error }`, then
kills the child. Nothing new is needed downstream of it except the reason
plumbing in section 3.

### 2. Cancel timeout is a successful forced stop

Same file, `cancel` with `cancelBehavior === "wait-for-prompt"`. When the
`cancelTimeout` race returns `None`:

- Build the `AcpTransportError` exactly as today, with `detail` extended by the
  stderr tail.
- Call `retireRuntime(error)`.
- **Return success** instead of `yield* error`.

The kill interrupts the prompt fiber; the prompt's release step already calls
`retireRuntime` again for interrupted `wait-for-prompt` prompts, and
`recordTermination` is idempotent (first termination wins), so the cancel
detail is the one that reaches the adapter.

The `"interrupt"` behavior is unchanged.

### 3. Retirement reason reaches the adapter

File: `apps/server/src/provider/Layers/AntigravityAdapter.ts`.

`handleEvent` case `"ConnectionTerminated"` currently sets `stopped` and
`disconnected` and forks `stopContext`. Add: if `context.fatalError` is unset
and `event.error` is an `AcpTransportError` with a `detail`, set
`context.fatalError = event.error.detail`. Other termination errors
(`AcpInputStreamEndedError` on a plain process exit, etc.) keep the existing
"Antigravity process stopped." default.

Turn settlement then flows through the paths that already exist:

- **Stall (section 1).** The prompt fiber fails with an interrupt cause;
  `runTurn`'s `Effect.onInterrupt` sees `context.disconnected === true` and
  settles the turn `failed` with `errorMessage: context.fatalError`, now the
  stall detail. `stopContext` emits `session.exited` with the same reason.
- **Forced stop (section 2).** `interruptTurn` returns success. The prompt fiber
  is interrupted; the same `onInterrupt` path runs. It must settle the turn
  **cancelled**, not failed, because the user asked for the stop. Distinguish
  the two by a flag on the session context set by `interruptTurn` before it
  calls `runtime.cancel` (`context.userCancelRequested = true`, cleared when the
  turn settles). `onInterrupt` computes:

  | `disconnected` | `userCancelRequested` | state       | errorMessage        |
  |----------------|-----------------------|-------------|---------------------|
  | false          | any                   | `cancelled` | none                |
  | true           | true                  | `cancelled` | `fatalError`        |
  | true           | false                 | `failed`    | `fatalError`        |

  `TurnCompletedPayload.errorMessage` is optional and independent of `state`,
  so a cancelled turn may carry the force-stop explanation.

The steer path also calls `runtime.cancel` (a new user message while a prompt
runs). A forced stop there settles the superseded turn `cancelled` with the
explanation and the new turn proceeds on a fresh process via the existing
restart path, exactly as a plain steer does today after a clean cancel.

### 4. `AcpTransportError.message` includes detail

File: `packages/effect-acp/src/errors.ts`.

```ts
override get message() {
  const method = this.method ? ` for method ${this.method}` : "";
  const base = this.operation
    ? `ACP transport operation ${this.operation} failed${method}.`
    : "ACP transport operation failed.";
  return this.detail ? `${base} ${this.detail}` : base;
}
```

Three existing assertions in `errors.test.ts` and `_internal/stdio.test.ts`
construct errors without `detail` and stay green; add one with `detail`.
`mapAntigravityError` and the Cursor/Grok/Prime error mappers wrap
`cause.message`, so they inherit the detail without changes. Check
`CursorTransportFailure.ts` still strips transport labels the way its test
expects (it matches on `_tag`, not message text, per upstream #11365).

### 5. Stderr tail

File: `apps/server/src/provider/acp/AcpSessionRuntime.ts`.

The runtime keeps a ring buffer of the last 20 stderr lines (each truncated to
400 chars) regardless of `onStderr`. Lines are appended where `onStderr` is
invoked today; `onStderr` itself is unchanged. `stderrTail` in sections 1 and 2
renders as `" Last stderr: <line> | <line> ..."` or empty when the ring is
empty. Secrets: Antigravity's stderr handler already treats browser-helper
auth URLs as sensitive; the ring buffer skips lines starting with
`ANTIGRAVITY_AUTH_STDOUT_PREFIX` or `ANTIGRAVITY_AUTH_BROWSER_MARKER` via an
optional `redactStderrLine?: (line: string) => string | undefined` runtime
option that `AntigravityAcpSupport` supplies.

### 6. Antigravity opt-in

File: `apps/server/src/provider/acp/AntigravityAcpSupport.ts`.

`makeAntigravityAcpRuntime` passes `promptInactivityTimeout: "5 minutes"` and
the stderr redactor. Evidence for the number: every observed hang exceeded
27 minutes; the longest legitimate gap with no tool call and no client request
in flight, across all Antigravity logs on the reference machine, was under
4 seconds. Setup, probe, and text-generation helpers that build a runtime
without `clientFileSystem` do not set the timeout (they do not run long
prompts).

### 7. Reactor and clients

No changes. `processTurnInterruptRequested`'s `stopSession` fallback remains
for genuine interrupt failures (e.g. transport already dead). Clients already
render `turn.completed` state and `errorMessage`, and session `lastError`.

## Testing

`AcpSessionRuntime.test.ts` already drives a mock agent over stdio. Add:

- Stall: prompt dispatched, agent emits an `agent_message_chunk`, then nothing;
  advance `TestClock` past the timeout; expect `ConnectionTerminated` with the
  stall detail, child killed, prompt fiber interrupted.
- Not a stall while a tool call is in progress: emit `tool_call` with
  `in_progress`, advance past the timeout, expect no termination; complete the
  tool call, advance again, expect termination.
- Not a stall while a permission request is pending: agent sends
  `session/request_permission`, handler blocks; advance past timeout; expect no
  termination.
- Activity resets the clock: chunks every `timeout/2`; expect no termination.
- Timeout disabled by default: no option, long silence, no termination.
- Forced stop: `wait-for-prompt`, agent ignores `session/cancel`; `cancel`
  **succeeds**, `ConnectionTerminated` carries the cancel detail, process
  killed.
- Stderr tail appears in the detail and redaction is applied.

`AntigravityAdapter.test.ts`:

- `ConnectionTerminated` with a detailed transport error → `turn.completed`
  `failed` with that `errorMessage` and `session.exited` with the same reason.
- `interruptTurn` when the runtime force-stops → `turn.completed` `cancelled`
  with the force-stop `errorMessage`; `interruptTurn` resolves successfully.
- Plain process exit → unchanged "Antigravity process stopped." text.

`errors.test.ts`: message with and without `detail`.

`ProviderCommandReactor.test.ts`: existing interrupt-failure fallback tests stay
green; add none unless behavior changes.

Focused commands: `vp test run <files>` for the files above, `vp run -F t3
typecheck`, `vp run -F effect-acp typecheck`, and lint on changed files.

## Rollout

- Ships as one PR against `pylon`, including this spec.
- Threshold is an option, not a constant, so it can be tuned per adapter.
- Report the missing `session/prompt` response to the Antigravity team with the
  evidence from `docs/superpowers/specs/2026-09-17-acp-prompt-liveness-design.md`
  (this file) and the trajectory-store observation. Track in the owning issue.
- Follow-up candidate (not in this PR): an orchestration-level "quiet for N
  minutes" activity for all providers that annotates without killing.
