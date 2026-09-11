# Architecture

Pylon keeps execution in the environment that owns the workspace. Web, desktop, and mobile
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's. The desktop app bundles a server,
but its renderer follows the same boundary.

## Ownership boundaries

Provider processes, terminals, Git, and project files belong to the server. Shared connection and
domain state belongs in `packages/client-runtime`; clients supply platform services and UI.
Keeping that logic shared prevents reconnect and multi-environment behavior from diverging between
web and mobile. See [connection runtime](./connection-runtime.md) and
[remote environments](./remote.md).

The [RPC contract](../../packages/contracts/src/rpc.ts) is the boundary between independently
versioned clients and servers. Subscriptions send the state a client needs, so a client viewing one
thread does not pay for every thread's history. Authentication of a socket does not authorize every
method on it. See [environment auth](./environment-auth.md).

Provider-specific behavior belongs behind an adapter. Orchestration works with normalized commands
and events, so adding a provider should not require branches throughout the domain or clients.
See [provider constraints](./providers.md).

## Durable intent and side effects

The event log is the source of truth for orchestration state. The
[engine](../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts) serializes commands;
the [decider](../../apps/server/src/orchestration/decider.ts) produces events without performing
provider or filesystem work. Events, persisted projections, and the accepted command receipt commit
in one database transaction. The in-memory state changes and subscribers receive events after that
commit. This keeps command retries idempotent and prevents a persisted projection from getting
ahead of the event log.

Reactors perform side effects after intent has been recorded, then feed results back through
commands. A command acknowledgement therefore means the intent committed, not that the provider,
checkpoint, or other follow-up work finished. Keep external I/O out of the decider and the database
transaction.

Persisted events must remain decodable on replay. Changing a schema affects old environments at
startup as well as live RPC traffic. Compatibility work must account for stored history, not just
what the newest client sends.

### Attachment cleanup is not event-sourced

Reverts and deletes remove attachment files after commit, so a failed cleanup cannot reject a
committed command. [Cleanup](../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts)
records its own `projection.attachment-cleanup` cursor in `projection_state`: every event at or
below it has been cleaned. Live commits write it with the projector cursors, trailing the head by
the current command; a failed cleanup holds it until the next start. Bootstrap runs after every
projector has caught up, so message and answer references are current, and scans only
`thread.reverted` and `thread.deleted` rows past the cursor without decoding payloads. A delete also
removes the thread's `browser-artifacts` folder, where transferred recordings and saved snapshots
live until the thread is deleted. That pass is the single retry: a file that still cannot be removed
is logged and left behind, and only a failure to list the attachments directory or read the log
holds the cursor. A database without the row starts at the lowest cursor of the projectors that
record cleanup, because their replay cleaned files before the cursor existed; adding an unrelated
projector does not move it.

`projection_state` can therefore hold rows that are not projectors. The snapshot sequence comes
only from the required projectors, so code reading that table must filter by projector name rather
than taking a minimum over every row.

### Settlement is server-owned

Each server's own settings control PR and inactivity settlement, and its settlement reactor runs
even when no client is connected. Clients render the persisted settlement state; they do not derive
it from PR or inactivity data. Because those settings are user preferences, clients write them to
[every shared-settings target](../../packages/client-runtime/src/state/sharedSettings.ts) with an
active connection, but only send keys the target advertises a capability for:
`threadAutoSettlement` for the baseline keys, and newer capabilities such as
`threadRestartContinuation` for later ones. An older server is never asked to hold a key it cannot
store.

## Turn completion and checkpoints

A turn ending and its follow-up work settling are separate milestones. The
[projector](../../apps/server/src/orchestration/projector.ts) settles the turn from its session
status. A late checkpoint or diff must not extend the recorded turn duration or keep the client
showing provider work as active.

[Checkpoints](../../apps/server/src/checkpointing/CheckpointStore.ts) use hidden Git refs to
capture workspace state without adding commits to the user's branch. A revert must coordinate
workspace state with the provider conversation. Pylon offers it only as an
[exact rollback saga](./rollback-recovery.md) for idle, Pylon-managed native Prime sessions whose
checkpoint has a matching conversation anchor. Every other provider must reject revert before
changing the filesystem. Server-side workspace leases fence Pylon's own writers; they cannot fence
external terminals, editors, or processes.

## Waiting for asynchronous work

Tests use [drainable workers](../../packages/shared/src/DrainableWorker.ts) to wait until both the
queue and its current item have finished. An empty queue alone does not prove the worker is idle.

Runtime receipts mark specific test milestones. Their
[production layer](../../apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts) is a no-op;
production behavior must use persisted state and events. These test signals are separate from the
durable command receipts that make dispatch idempotent.

## Desktop startup and native isolation

The Electron shell acquires `DesktopPreReadyPlatform.layer` synchronously before asynchronous
services. On Linux this sets the desktop-entry identity and global-shortcut portal flags before
Chromium initializes its portal connection. Setting the identity later in `DesktopAppIdentity`
is too late: Chromium caches the first registration, including failures. The identity must match
the installed entry managed by `DesktopLinuxUrlHandler`, and portals reject application IDs
without a reverse-DNS dot, so each channel uses `com.pylon.code[.dev|.nightly].desktop`.

Electron derives every window's WM class and Wayland app ID from that name, so `linuxWmClass` and
the AppImage `StartupWMClass` use the same `com.pylon.code[.nightly]` ID; launchers that name
another class stop grouping with running windows. Desktops that match a window by app ID land on
the hidden entry, so it carries the channel's name and an `Icon=` pointing at a copy of the bundled
icon under `$XDG_DATA_HOME/<app-id>/icon.png`, because the AppImage mount path changes every launch.

After the scheme default moves to the new entry, the URL handler deletes the
`pylon-code-url-handler.desktop` entry that earlier builds wrote, but only when its content is still
Pylon's generated hidden handler, and never while the default could not be moved. Pre-ready setup
also refreshes that entry's `Exec` path before portal registration: AppImage updates can remove the
previous executable, which invalidates the old entry even though its filename is correct. The later
URL handler avoids rewriting an identical entry while the portal may be reading it. On Wayland,
Electron's synchronous shortcut-registration result only confirms submission; it does not confirm
desktop consent or an active binding.

Native modules never load in the Electron main process on the startup path, and the two the
snapshot feature keeps are isolated: `@crowecawcaw/xa11y` runs only in forked Node-mode children
(`SnapShotAccessibilityWorker`, `RegionSnapShotWorker`) and a worker thread, and `ffi-rs` loads
lazily inside `WindowsForeground.ts` for a handful of Win32 calls. macOS window lookup shells out
to `osascript` instead of a native addon. A crash or stall in any of these must not take the app
down, so new native capability goes in a child with a deadline, not an `import` in main. See
[Linux window capture](./linux-snap-shot.md) for the Wayland backends.

See the [glossary](./glossary.md) for shared terms and the
[development runbook](../operations/development.md) for setup and checks.
