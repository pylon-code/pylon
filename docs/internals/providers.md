# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with seven entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |
| `primeAgent`  | [`Drivers/PrimeAgentDriver.ts`][prime]  |
| `jcode`       | [`Drivers/JcodeDriver.ts`][jcode]       |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

Prime Agent uses its public detached-daemon APIs as the primary runtime. One scoped daemon belongs
to a provider instance, while each Pylon thread owns an isolated, deterministic native session
directory. The client-visible continuation cursor stays an opaque marker; a server-private sidecar
binds it to the exact stable Prime transcript identity and verifies the saved file before cold
resume. On POSIX filesystems the thread session directory is owner-only, and its identity,
managed-extension, and native transcript files are protected before the session becomes usable. Prime-native events terminate in
`provider/prime/*` and map to provider-neutral runtime contracts; daemon identifiers, sockets,
paths, request IDs, and native payloads never cross the provider boundary. The
[Prime Agent daemon parity ledger](prime-agent-daemon-parity.md) records every public API outcome
that is integrated, deliberately folded into Pylon semantics, deferred, or unavailable upstream.

A short-lived RPC probe bootstraps the qualified model catalog. After a compatible daemon session
attaches, the adapter calls Prime's public `getModelCatalog` (or `getAvailableModels` compatibility
fallback), filters to configured providers, discards sensitive native fields, and publishes a bounded
last-good model overlay through the existing provider snapshot stream. Once that overlay exists,
provider health checks retain it without repeating the RPC discovery probe or reporting a stale
fallback warning. No session is created only for model discovery. The synthetic `default` model means
“do not force a model,” while discovered model metadata drives generic thinking and service-tier
composer options. The daemon adapter can switch
models before a turn, steer an active turn, admit
explicit follow-ups, choose all-at-once or one-at-a-time delivery independently for steering and
follow-up inputs, and clear pending inputs without aborting current work. Native queue previews
terminate at the adapter boundary: only bounded steering/follow-up counts and normalized delivery
modes use the stable `session.input-queue.updated` activity projection. Mode writes share the
thread-mutation lock with queue, lifecycle, reload, depth, and agent-control mutations. The adapter
reconciles the authoritative native queue after a rejected write and closes the session when a timeout
leaves ownership ambiguous. Follow-up text follows the normal durable user-message
command path, so an admission failure leaves the message in history with an explicit not-queued
activity rather than deleting user intent. Clearing pending native inputs likewise does not erase durable
history. Queued native runs stay inside one Pylon turn until the queue settles. Mobile's
file-backed device outbox remains a separate reliability layer. Approval-required sessions
materialize a server-owned, token-correlated Prime extension, disable extension discovery, verify
the generated source plus the loaded extension-sourced marker through public resource APIs, set and
verify RLM depth zero before prompt admission, reject slash-command prompts that bypass tool hooks,
and disable unverified daemon recovery so transport loss requires a fresh verified session. Its
blocking hooks map reviewable built-in edit, shell, and IPython requests privately to canonical
Pylon approval events; unknown tools and oversized inputs are denied rather than incompletely
presented. Native request IDs and policy tokens remain adapter-local. Provider-exposed final reasoning is
bounded into the shared work-log item shape; incremental deltas and provider-private reasoning
metadata are discarded at the Prime boundary. Public daemon session statistics are decoded behind
an identity check and reduced to the active context estimate, current model window, and exact
automatic-compaction setting. The adapter also decodes Prime's RLM depth status into a stable
provider-neutral session activity and accepts only per-session depth writes from 0 through 4 while
idle. Its authoritative settable-now flag also tracks native runs, bash, child agents, compaction,
blocking interactions, approvals, and resource reloads so remote clients do not offer a write that
would only fail as busy. The setter never passes the global persistence option, and supervised
sessions remain policy-fixed at zero. Agent cancellation uses a provider-neutral, operate-scoped RPC keyed by the Pylon thread and the already-projected opaque task ID. The Prime adapter validates that ID against the thread's known active descendant roster before calling the public `cancelRlmChild` API; it never accepts a native active-session selector. Duplicate cancellation requests coalesce while the native terminal update is pending. Native cancellation has a fixed deadline; `false`, a racing completion, a failed call, or a timed-out response triggers one reconciliation against the latest decoded roster rather than a mutation retry. If that roster cannot restore authority, the session is closed. Prime's public `getInitialSnapshot()` does not refetch live children, so the runtime seeds this private roster from attach/resync snapshots and updates it synchronously from bounded child events before exposing those events. Initial active-child and reconnect snapshots reconcile task rows, and a previously active child missing from an authoritative live-descendant snapshot is settled so clients cannot retain an uncontrollable working row. The first native terminal child update remains authoritative; later terminal repeats are ignored so cancellation races cannot append duplicate terminal activities. Tool results containing native child handles or session paths are replaced at the Prime decoding boundary before they can enter runtime events. Native agent messaging is a separate operate-scoped provider RPC keyed by the same canonical task ID. The adapter consults its current private event-driven roster, resolves that ID to a bounded native active-session endpoint, and invokes public `sendAgentMessage` exactly once under the thread mutation lock. Only `delivered` or `queued` acceptance crosses back to the initiating client; native receipt IDs, sender/target identities, timestamps, echoed text, and delivery errors are discarded. Pylon persists no sent-message content or receipt activity, while Prime necessarily retains the message in the child session's private transcript. Post-invocation failure is reported as delivery uncertainty and is never retried automatically. A provider-neutral `messageable` boolean tells clients which live rows currently have an endpoint without exposing it. Prime's daemon-global agent-message pause/resume/clear controls remain unavailable because their cross-session effects are unsafe for Pylon's multi-client provider model. Web, desktop, and mobile gate message and stop affordances on the active session's advertised agent operations rather than the provider name.

Live child activity is a separate read-scoped, non-orchestration stream. The client supplies a canonical task ID already present in the thread's active-agent projection; the Prime adapter resolves it only through its private authoritative descendant roster before calling public `watchSession`. Concurrent subscribers for the same child and native endpoint share one reference-counted read-only native attachment, while revisions and lifetime quotas remain subscriber-local. The server sanitizes the initial committed messages and Prime's public replacement, resync, and message-stream events into bounded replacement snapshots, retaining only non-empty assistant text parts; child prompts, system/developer messages, tool calls and results, thinking, attachments, errors, usage, native identities, timestamps, and envelopes terminate at the Prime boundary. Snapshot size, entry count, update count, lifetime characters, initialization events, and concurrent watchers are hard-capped. Duplicate snapshots are suppressed and native event bursts are debounced. No runtime event or orchestration activity is created, and durable child lifecycle projections discard native answer previews, recaps, and errors, so neither SQLite nor clients without an open view receive the assistant text. Stream finalizers close the shared watcher after its last panel owner leaves, or immediately on WebSocket cancellation, roster settlement/removal, endpoint replacement, session stop, provider replacement, or scope shutdown. Prime Agent 0.7.1 can attach only to a currently live child and exposes neither an atomic history cursor nor reopen for exited children; capability and UI wording therefore promise only **Live activity**, never a durable or lossless transcript.

Quick questions use a separate operate-scoped unary RPC and never enter provider runtime ingestion or orchestration. The per-WebSocket handler owns a Pylon request ID, while the Prime adapter maps it to an unguessable native ID and accepts only exact correlated terminal events. It returns one answer after completion; prompt text, cumulative native updates, errors, IDs, and lifecycle never cross into durable state or other Pylon clients. Questions and answers have UTF-8 and character bounds, cumulative native traffic and updates are capped, and at most one question per thread plus a provider-wide concurrency limit can run for two minutes. Cancellation, timeout, request interruption, WebSocket disconnect, session replacement, and scope shutdown run one best-effort native abort without retry. Because Prime 0.7.1 side agents inherit provider extension hooks even with `tools: []`, this operation is admitted only in fresh supervised sessions where discovery is disabled and Pylon's verified permission extension cannot act on a tool-free response. Full-access, restored, and ACP sessions fail closed.

Heartbeat methods are deliberately not advertised yet despite existing on the public daemon connection. A heartbeat can initiate a native run without a public dispatch identity that Pylon can map to an autonomous orchestration turn and pre/post filesystem checkpoints. `setHeartbeat` also promotes a client-owned worker to resident ownership, while the public connection lacks authoritative ownership inspection, demotion, or resident termination after clear. Pylon's reaper, thread deletion reactor, and restart attachment model currently assume client-owned sessions. Shipping creation before synthetic autonomous turns, resident reattachment, reaper exclusion, and fail-safe clear/stop/delete semantics would permit invisible mutations or orphaned scheduled work. This is an integration lifecycle blocker rather than a claim that Prime lacks heartbeat CRUD.

A typed provider-neutral clear barrier retracts stale meters while
Prime reports post-compaction context as unknown; aggregate retained-session counts and native
identity, path, percentage, and cost fields are not conflated with active context usage. Prime compaction start and terminal events replace one provider-neutral lifecycle activity row; native instructions, summaries, result details, token metadata, and error text are discarded before canonical runtime mapping. A separate stable `session.compaction.updated` projection carries only availability, `idle`/`starting`/`compacting`/`abort-requested` status, the authoritative automatic-compaction boolean, abortability, writability, and idle-only manual settable state. Manual compaction calls public `compact()` without instructions only after a state-only read confirms there is no native run, bash action, queued action, child, approval, interaction, resource reload, or compaction. The long native promise runs under the owned session scope while start/end events and public state remain lifecycle authority. `abortCompaction()` marks only request acceptance until terminal state arrives. `setAutoCompactionEnabled()` is exposed with scope `session-and-provider-default` because Prime persists its provider-wide default. All three mutations share the thread mutation lock, perform no automatic retry, reconcile once after rejection, and close an ambiguous session. Supervised sessions and ACP publish unavailable control barriers. Goal observation follows the same
provider-neutral projection model: `session.goal.updated` stores only availability, active state,
normalized status, a bounded objective, token budget and usage, elapsed seconds, and continuation
count. Native goal IDs, timestamps, reasons, and errors terminate at the Prime boundary. Clients
select the latest stable snapshot for the active provider instance, require the provider's advertised
`goals.observe` capability and a live full-access runtime, and treat unavailable snapshots and
runtime/provider changes as clear barriers. Web, desktop, and mobile expose this state as a read-only
composer control. Prime Agent 0.7.1 exposes no corresponding daemon methods for create, update,
pause, resume, complete, or clear, so Pylon reports those operations as unavailable rather than
simulating them as orchestration mutations. The same ingestion boundary drops compacted-state
detail from other providers. Finite non-negative `turn.completed.totalCostUsd` values become stable,
turn-linked `turn.cost` metadata activities. Retry and refinement events likewise cross the Prime
boundary only as safe numeric lifecycle state; ingestion replaces stable provider-neutral rows and
represents partially applied refinements separately from total failure. Explicit local harness
refinement is an operate-scoped `provider.refineSessionHarness` RPC with only `{ threadId }` on the
wire. The Prime runtime advertises it only when the public `DaemonAgentConnection.refine` method is
present, and invokes that method exactly once with `{ global: false }`; Pylon has no instructions,
rollback identity, or global-scope contract. Only new full-access daemon sessions are eligible:
supervised, restored, ACP, missing-method, and concurrent-refinement paths fail closed. The sanitized
public method response is authoritative for the RPC and retains only non-negative applied/failed
counts plus `completed`/`partial`/`failed`; public `refine_complete` and `refine_failed` events remain
uncorrelated observational lifecycle rows, so automatic or agent-initiated refinement cannot satisfy
a Pylon request. A rejected or timed-out request is reported as outcome-unknown, never retried, and
keeps the session reservation closed to another refinement until session teardown because Prime may
still apply it after the client timeout. Pylon projects only `running`, `available`, or
`outcome-unknown` on that safe session incarnation so remounted and remote clients share the same
control barrier without persisting native refinement content. Before refinement is available, Pylon creates the derived
native artifact and harness directories as owner-only; after confirmed success it also protects known
harness files as owner-readable and writable only. Stop, close, disposal, and provider shutdown clear
and fail the reservation. Proposals, instructions, summaries, paths, edit details, native identities,
raw results, and logs terminate at the Prime boundary. Clients exclude cost metadata from work logs and show the
provider-reported estimate only beside the terminal assistant message. Prime's retained-session
statistics cost is never treated as a lifetime or per-turn total. The gate fails closed, but it is not an OS sandbox,
so approved IPython and shell calls retain host access. ACP remains an explicit
compatibility fallback for custom launch arguments or failed daemon setup. The fallback snapshot
strips daemon-only model options and capabilities rather than rendering controls ACP would ignore.

Jcode is an Early Access driver over the public Jcode SDK's protocol v1. One private daemon belongs
to a provider instance, launched with a per-instance Pylon-owned Jcode home and a sanitized
environment; each Pylon thread owns one durable native session bound through a server-private
sidecar, and the client-visible continuation cursor stays opaque. Native session ids, socket paths,
and daemon identifiers terminate at the adapter boundary. The driver probes the configured
executable exactly once at create time with `["--version"]` and reuses that observation as the
initial snapshot, so a disabled instance spawns nothing and a failed launch publishes
`status: "error"` with an empty catalog rather than a shadow `ready`. Models come from the attached
session, so there is no hardcoded default; unavailable routes are dropped from the catalog rather
than offered.

Jcode's execution policy is `full-access` only, published as snapshot data rather than as a driver
branch in orchestration: `JcodeProvider` declares `supportedRuntimeModes: ["full-access"]`, the
registry derives routing information from that snapshot, and `ProviderService` rejects an
unsupported mode at both `startSession` and `recoverSessionForThread`. Reconnect is deliberately
disabled — protocol v1 cannot replay, so a resurrected stream would present a hole as continuity;
`session.exited` retires the session so the thread is immediately startable again. Optional adapter
members Jcode cannot honor are omitted rather than stubbed, because absence is the repo's
established unsupported signal, and background text generation fails with a typed unavailable error
because SDK v1 cannot disable host tools for a structured run.

Reject-versus-coerce is a deliberate split, not an accident. The server _rejects_: an unsupported
runtime mode fails at both `ProviderService.startSession` and `recoverSessionForThread`, before any
MCP credential is issued or any provider process is engaged. Clients _coerce_: the generic
`resolveServerProviderRuntimeMode` helper in contracts reads `supportedRuntimeModes` off the live
snapshot and resolves a selection to a supported one, so a normal user-driven start does not reach
the server's refusal. The helper names no driver, and Jcode adds no branch to it.

The coerce half is currently pinned on mobile only, through `resolveModelSelectionRuntimeMode` in
`apps/mobile/src/lib/modelOptions.ts`. Web does not consult `supportedRuntimeModes` before starting
a session today, so on web a stale or unsupported persisted mode surfaces as the server's typed
refusal rather than as a narrowed control. Rejection is the correct backstop either way — for stale
persisted state and for a provider that narrows its policy after a choice was made — but the web
half of the coercion story is a known gap, not a design claim.

The [Jcode SDK blocker ledger](jcode-sdk-blockers.md) records the exact SDK requirements that must
land before each withheld capability can be enabled.

## Client presentation

Clients learn about a provider through generic shared metadata plus the server snapshot; adding a
driver to a client is registration, not new rendering code.

- Web: `apps/web/src/components/settings/providerDriverMeta.ts` carries label, icon, optional
  Early Access badge, and the settings schema that `AddProviderInstanceDialog`,
  `ProviderSettingsPanel`, `ProviderInstanceCard`, and `ProviderSettingsForm` all render
  generically. `apps/web/src/components/chat/providerIconUtils.ts` maps the driver kind to its
  icon for chat, sidebar, and model presentation. `PROVIDER_OPTIONS` in
  `apps/web/src/session-logic.ts` is a static presentation list kept in sync with the driver set;
  it is explicitly not the authoritative configured-instance source, and it currently has no
  production consumer beyond the `AVAILABLE_PROVIDER_OPTIONS` filter derived from it. The live
  picker, composer, sidebar, and default-selection paths all read the server snapshot through
  `providerInstances.ts`, which is generic over driver kind.
- Desktop wraps the web client, so it inherits the same registration with no separate work.
- Mobile registers the icon in `apps/mobile/src/components/providerIconKind.ts` plus
  `ProviderIcon.tsx`, and the display label in `apps/mobile/src/lib/modelOptions.ts`. Mobile has no
  provider-host configuration: it consumes the environment's server-authoritative snapshot.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[prime]: ../../apps/server/src/provider/Drivers/PrimeAgentDriver.ts
[jcode]: ../../apps/server/src/provider/Drivers/JcodeDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
