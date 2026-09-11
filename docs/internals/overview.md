# Architecture

> For maintainers. Using Pylon? See [docs/user](../user/).

Pylon is a server runtime that owns agent sessions, workspaces, and version control, plus clients
(web, desktop, mobile) that talk to it over one authenticated Effect RPC WebSocket. The server is the
execution boundary: every provider process, terminal, git operation, and filesystem read happens
there, never in the client.

```
┌────────────────────────────────────────────────┐
│ Clients: apps/web, apps/desktop, apps/mobile   │
│ shared runtime: packages/client-runtime        │
│  connection supervisor, RPC session, Atom state│
└──────────────────┬─────────────────────────────┘
                   │ Effect RPC over WebSocket (/ws)
                   │ contract: packages/contracts
┌──────────────────▼─────────────────────────────┐
│ apps/server                                    │
│  orchestration engine (event-sourced)          │
│  provider driver registry (5 built-in drivers) │
│  checkpointing, VCS, terminals, filesystem     │
└──────────────────┬─────────────────────────────┘
                   │ per-driver transport
┌──────────────────▼─────────────────────────────┐
│ Agent CLIs: Codex, Claude, Cursor, Grok,       │
│ OpenCode                                       │
└────────────────────────────────────────────────┘
```

## The RPC boundary

The client/server contract is an Effect RPC group, not a hand-rolled push protocol. [`rpc.ts`][rpc]
declares `WS_METHODS` and assembles `WsRpcGroup`; each member is either unary or a server stream
(`stream: true`). Streaming members such as `orchestration.subscribeShell`,
`orchestration.subscribeThread`, `subscribeServerConfig`, and `terminal.attach` replace what used to
be a broadcast push bus: a client subscribes to what it needs and the server pushes only on that
subscription.

[`ws.ts`][ws] serves the group. `websocketRpcRouteLayer` mounts `GET /ws`, authenticates the upgrade
through `EnvironmentAuth.authenticateWebSocketUpgrade`, then hands the socket to
`RpcServer.toHttpEffectWebsocket`. Authorization is per method: `RPC_REQUIRED_SCOPE` maps each method
to a scope, and `authorizeEffect`/`authorizeStream` enforce it. Holding a valid socket is not
authorization to call everything on it. See [environment-auth.md](./environment-auth.md).

On the client, [`session.ts`][session] opens the socket and builds the typed client.
`RpcSessionFactory` is the service; a session exposes `client`, `initialConfig`, `ready`, `probe`,
and `closed`. It performs one attempt and does not retry. Retry, backoff, and offline policy belong
to the connection supervisor.

## Shared client runtime

`packages/client-runtime` holds every non-visual client concern: connection lifecycle,
authentication, RPC, cached environment data, and domain state as Atom factories. Web and mobile
compose it the same way (`apps/web/src/connection/runtime.ts` and
`apps/mobile/src/connection/runtime.ts` mirror each other, differing only in platform-specific
background-activity layers) and differ beyond that only in the platform layer they supply and the
UI they build on top. React components never construct transports, retry loops,
or RPC clients. See [connection-runtime.md](./connection-runtime.md).

## Orchestration is event-sourced

The server does not mutate app state directly. Clients dispatch typed commands; the engine turns them
into persisted events; projections derive the read model.

[`OrchestrationEngine.ts`][engine] serializes this. `dispatch` offers a `CommandEnvelope` onto
`commandQueue` and awaits its result; a single worker fiber takes envelopes one at a time, so command
processing is totally ordered. For each envelope `processEnvelope`:

1. checks the durable command receipt, making retries idempotent;
2. runs `decideOrchestrationCommand` ([`decider.ts`][decider]) to produce events from command plus
   current state, pure and side-effect free;
3. inside one SQL transaction, appends events to the event store, applies them to the in-memory read
   model via [`projector.ts`][projector], projects them into persisted tables, and writes the
   accepted receipt;
4. after commit, swaps in the new read model, cleans up attachments, and publishes committed events
   to subscribers. Attachment cleanup failures are logged and do not reject committed commands.

Because persistence and projection share a transaction, the read model cannot durably disagree with
the event log. On dispatch failure the engine rereads persisted events past the starting sequence and
reconciles.

### Attachment cleanup cursor

Attachment files are not event-sourced, so reverts and deletes clean them after commit. Cleanup
records its progress in its own `projection.attachment-cleanup` row in `projection_state`, meaning
every event at or below it has been cleaned (`ProjectionPipeline.ts`):

- **Live.** The cursor is written in the same statement as the projector cursors, at the last event
  whose cleanup finished. Cleanup runs after commit, so it trails the head by the current command.
  A failed cleanup stops the cursor until the next bootstrap. A transaction that rolls back never
  ran its cleanup, so it leaves no gap.
- **Bootstrap.** After every projector has caught up, so message and `user-input.answer-submitted`
  references are current, bootstrap selects only the `thread.reverted` and `thread.deleted` rows
  past the cursor, without decoding payloads. It lists the attachments directory once, and the
  browser artifacts directory once when a delete is in range (transferred recordings and saved
  snapshots live in `browser-artifacts/<thread>/`, which only deleting the thread removes). Threads
  with neither kind of file are skipped; if the artifacts listing fails, each deleted thread's
  folder is removed directly instead. It then moves the cursor to the projector head. That pass is
  the single retry: a file that still cannot be removed is logged and left behind rather than
  holding the cursor. A database without the row starts at the lowest cursor of the projectors
  that record cleanup (threads, messages, activities), because their replay cleaned files before
  this cursor existed; adding an unrelated projector does not move it. Only a failure to list the
  attachments directory or read the log leaves the cursor for the next start.

`projection_state` can therefore hold rows that are not projectors. The snapshot sequence comes only
from the required projectors (`computeSnapshotSequence` in `ProjectionSnapshotQuery.ts`), and code
reading the table must filter by projector name rather than taking a minimum over every row.

Command and event names live in [`orchestration.ts`][contracts]. Some commands are client
dispatchable (`thread.create`, `thread.turn.start`, `thread.approval.respond`); others are internal
and produced only by server-side reactors (`thread.message.assistant.delta`,
`thread.turn.diff.complete`).

A turn is complete when its session leaves `running` status, projected by
`settledTurnStateForSessionStatus` in [`projector.ts`][projector]. Checkpoint work settling later
does not define turn end.

Thread settlement is server-owned. Each server's own settings control PR and inactivity
settlement. Those keys are user preferences, so clients write them to every shared-settings sync
target (`SHARED_SERVER_SETTING_KEYS` in `packages/client-runtime/src/state/sharedSettings.ts`) and
warn when another target drifts. A target must have an active connection and advertise the
`threadAutoSettlement` capability for the baseline shared keys. Clients separately filter newer
keys by their required capabilities, including `threadRestartContinuation`.
[`ThreadSettlementReactor`][settlement] checks threads at startup, when those settings change, and
once per minute, including when no client is connected. It dispatches the guarded internal
`thread.auto-settle` command, which uses the existing settlement event lifecycle. Automatic
settlement excludes live background work and requires a comparable PR timestamp for immediate PR
settlement. The command carries the latest activity timestamp and rejects any later event for its
thread after the reactor's snapshot. The sweep looks a branch up from the thread's worktree when it
still exists, so it shares the per-cwd PR cache the sidebar polls instead of spending a second host
request. Clients render the persisted settlement state and do not derive settlement from PR or
inactivity state. A committed `thread.settled` event also lets `ProviderCommandReactor` stop an idle
provider session.

At turn completion, `CheckpointReactor` refreshes PR discovery when the checkout matches the
thread's non-default branch. `VcsStatusBroadcaster` requires loaded remote status and permission
from background policy. `GitManager` retries only a successful "no PR" cache entry for the current
branch, preserving known PRs and failure backoff without fetching remotes. Remote status reads
that write the broadcaster cache share a lock per cwd, including the initial status load.

## Drainable workers

Follow-up work runs asynchronously in queue-backed workers built on [`DrainableWorker`][worker]:
[`ProviderRuntimeIngestion`][ingest] normalizes provider runtime streams into orchestration commands,
[`ProviderCommandReactor`][cmd] dispatches provider calls in response to intent events,
[`CheckpointReactor`][checkpoint] captures workspace checkpoints and rejects coordinated rollback
requests while rollback is disabled, and [`ThreadSettlementReactor`][settlement] evaluates
server-owned automatic settlement rules.

`DrainableWorker` pairs a transactional queue with a transactional count of outstanding items.
`enqueue` atomically offers and increments; processing always decrements. `drain` retries until the
count reaches zero, so a test can await "queue empty and current item finished" instead of sleeping.
Each of these four services exposes `drain` for exactly this.

Runtime receipts are a test-only mechanism. `RuntimeReceiptBusLive` in
[`RuntimeReceiptBus.ts`][receipts] publishes nothing; only the test layer is PubSub-backed. Do not
build production behavior on receipts.

## Provider drivers

Five drivers ship built in, registered in [`builtInDrivers.ts`][drivers] as `BUILT_IN_DRIVERS`:
Codex, Claude, Cursor, Grok, and OpenCode. A driver declares its kind and config schema and creates a
scoped adapter; `ProviderInstanceRegistry` owns live instances and `ProviderAdapterRegistry` resolves
an instance to its adapter, so `ProviderService` routes session and turn operations without knowing
which agent is behind them. See [providers.md](./providers.md).

## Checkpointing

Each turn is bracketed by workspace checkpoints so diffs are exact. `CheckpointStore` captures
state as hidden Git refs through the VCS driver's checkpoint operations; `CheckpointDiffQuery`
answers turn and full-thread diff requests; and `CheckpointReactor` coordinates baseline capture,
completed-turn capture, and diff projection. Coordinated rollback is intentionally disabled until
exact immutable filesystem and provider anchors, complete canonical writer fencing, postcondition
proof, and restart recovery ship. Server-side leases cannot fence writes from external
terminals, editors, or processes. The storage contract is `VcsCheckpointOps` in
[`VcsDriver.ts`](../../apps/server/src/vcs/VcsDriver.ts), implemented for Git in the same directory.

## Startup

[`serverRuntimeStartup.ts`][startup] runs a fixed lifecycle: start keybindings, settings, and
reactors; publish welcome; signal command readiness (logged as `Accepting commands`); wait for the
HTTP listener via `markHttpListening`; publish ready; fork the heartbeat; then either print headless
output or open the browser. Command readiness precedes the listener, so a socket that opens can
already dispatch.

## Desktop startup and native isolation

The Electron shell acquires `DesktopPreReadyPlatform.layer` synchronously before asynchronous
services. On Linux this sets the desktop-entry identity and global-shortcut portal flags before
Chromium initializes its portal connection. Setting the identity later in `DesktopAppIdentity`
is too late: Chromium caches the first registration, including failures. The identity must match
the installed entry managed by `DesktopLinuxUrlHandler`, and portals reject application IDs
without a reverse-DNS dot, so each channel uses `com.pylon.code[.dev|.nightly].desktop`. Electron
derives every window's WM class and Wayland app ID from that name, so `linuxWmClass` and the
AppImage `StartupWMClass` use the same `com.pylon.code[.nightly]` ID; launchers that name
another class stop grouping with running windows. Desktops that match a window by app ID land on the
hidden entry, so it carries the channel's name and an `Icon=` pointing at a copy of the bundled
icon under `$XDG_DATA_HOME/<app-id>/icon.png` (the AppImage mount path changes every launch).
After the scheme default moves to the new
entry, the URL handler deletes the `pylon-code-url-handler.desktop` entry earlier builds wrote,
but only when its content is still Pylon's generated hidden handler, and never while the default
could not be moved. Pre-ready setup also refreshes that entry's `Exec` path before
portal registration: AppImage updates can remove the previous executable, which makes the old
entry invalid even though its filename is correct. The later URL handler avoids rewriting an
identical entry while the portal may be reading it. On Wayland, Electron's synchronous
shortcut-registration result only confirms submission; it does not confirm desktop consent or
an active binding.

Native modules never load in the Electron main process on the startup path, and the two the
snapshot feature keeps are isolated: `@crowecawcaw/xa11y` runs only in forked Node-mode children
(`SnapShotAccessibilityWorker`, `RegionSnapShotWorker`) and a worker thread, and `ffi-rs` loads
lazily inside `WindowsForeground.ts` for a handful of Win32 calls. macOS window lookup shells out
to `osascript` instead of a native addon. A crash or stall in any of these must not take the app
down, so new native capability goes in a child with a deadline, not an `import` in main. See
[Linux window capture](./linux-snap-shot.md) for the Wayland backends.

## Related

- [Workspace layout](./workspace-layout.md), [Glossary](./glossary.md)
- [Mobile navigation headers](./mobile-navigation.md)
- [Remote environments](./remote.md), [Server updates](./server-updates.md)
- [Resource telemetry](./resource-telemetry.md)
- [Scripts](./scripts.md), [CI gates](./ci.md)

[rpc]: ../../packages/contracts/src/rpc.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[ws]: ../../apps/server/src/ws.ts
[session]: ../../packages/client-runtime/src/rpc/session.ts
[startup]: ../../apps/server/src/serverRuntimeStartup.ts
[engine]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[decider]: ../../apps/server/src/orchestration/decider.ts
[projector]: ../../apps/server/src/orchestration/projector.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[settlement]: ../../apps/server/src/orchestration/ThreadSettlementReactor.ts
[receipts]: ../../apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts
[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
