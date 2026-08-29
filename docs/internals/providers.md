# Provider architecture

> For maintainers. Using Pylon? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. Pylon supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with six entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |
| `primeAgent`  | [`Drivers/PrimeAgentDriver.ts`][prime]  |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

Prime Agent uses its public detached-daemon APIs as the primary runtime on POSIX hosts. Windows fails
closed to ACP compatibility mode because Prime Agent 0.8.1 does not expose a verifiable named-pipe
ACL or authenticated peer handshake; a stable pipe name alone is not a trust boundary. One scoped daemon belongs
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
fallback warning. Cached models never override a disabled, missing, or unhealthy probe's authentication
state. A healthy non-empty native catalog can report configured-provider readiness; an empty catalog
leaves authentication unknown because it is not a credential-status API. No session is created only for model discovery. The synthetic `default` model means
“do not force a model,” while discovered model metadata drives generic thinking and service-tier
composer options. The daemon adapter can switch
models before a turn, steer an active turn, admit
explicit follow-ups, choose all-at-once or one-at-a-time delivery independently for steering and
follow-up inputs, clear pending inputs, and remove the sole item in either lane without aborting
current work. Native queue previews terminate at the adapter boundary: only bounded steering/follow-up
counts and normalized delivery modes use the stable `session.input-queue.updated` activity projection.
Sole-item removal privately reads Prime's preview, performs one compare-and-delete through an isolated
non-recovering daemon client, and then reconciles the authoritative queue. The mutation connection is
closed after that request, so transport recovery cannot replay an ambiguous outcome. General removal and reordering
remain unavailable because count-only clients cannot safely identify one item among several. These writes
share the thread-mutation lock with lifecycle, reload, depth, and agent-control mutations. The adapter
closes the session only when authoritative queue reconciliation also fails. Follow-up text follows the normal durable user-message
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
idle. Prime Agent 0.8.1's fresh no-override fallback is depth 2; explicit session, global, and
`RLM_MAX_DEPTH` sources remain authoritative, and Pylon does not persist a global write. Its
settable-now flag also tracks native runs, bash, child agents, compaction,
blocking interactions, approvals, and resource reloads so remote clients do not offer a write that
would only fail as busy. The setter never passes the global persistence option, and supervised
sessions remain policy-fixed at zero. Agent cancellation uses a provider-neutral, operate-scoped RPC keyed by the Pylon thread and the already-projected opaque task ID. The Prime adapter validates that ID against the thread's known active descendant roster before calling the public `cancelRlmChild` API; it never accepts a native active-session selector. Duplicate cancellation requests coalesce while the native terminal update is pending. Native cancellation has a fixed deadline; `false`, a racing completion, a failed call, or a timed-out response triggers one reconciliation against the latest decoded roster rather than a mutation retry. If that roster cannot restore authority, the session is closed. Prime's public `getInitialSnapshot()` does not refetch live children, so the runtime seeds this private roster from attach/resync snapshots and updates it synchronously from bounded child events before exposing those events. Initial active-child and reconnect snapshots reconcile task rows, and a previously active child missing from an authoritative live-descendant snapshot is settled so clients cannot retain an uncontrollable working row. The first native terminal child update remains authoritative; later terminal repeats are ignored so cancellation races cannot append duplicate terminal activities. Tool results containing native child handles or session paths are replaced at the Prime decoding boundary before they can enter runtime events. Native agent messaging is a separate operate-scoped provider RPC keyed by the same canonical task ID. The adapter consults its current private event-driven roster, resolves that ID to a bounded native active-session endpoint, and invokes public `sendAgentMessage` exactly once under the thread mutation lock. Only `delivered` or `queued` acceptance crosses back to the initiating client; native receipt IDs, sender/target identities, timestamps, echoed text, and delivery errors are discarded. Pylon persists no sent-message content or receipt activity, while Prime necessarily retains the message in the child session's private transcript. Post-invocation failure is reported as delivery uncertainty and is never retried automatically. A provider-neutral `messageable` boolean tells clients which live rows currently have an endpoint without exposing it. Prime's daemon-global agent-message pause/resume/clear controls remain unavailable because their cross-session effects are unsafe for Pylon's multi-client provider model. Web, desktop, and mobile gate message and stop affordances on the active session's advertised agent operations rather than the provider name.

Prime main-thread tool lifecycle is durable orchestration activity, but its correlation and presentation are provider-specific at ingestion: stable opaque IDs replace native Prime item IDs, and start/update/completion upsert one row. Both daemon and ACP producers are reduced to fixed allowlisted labels before persistence. Arguments, progress text, results, paths, commands, native titles, native IDs, and error text are discarded. Non-Prime providers keep their existing event IDs, status, detail, and data behavior.

Prime Agent 0.8.1 adds an optional ACP assistant `messageId` to mark autonomous message boundaries. The shared ACP runtime trims and tracks that token only while a segment is active, rotates its own opaque assistant item ID when the token changes, and retains the previous single-segment behavior when the token is missing. The upstream value is never used as a canonical item ID or copied into a provider runtime event.

Live child activity is a separate read-scoped, non-orchestration stream. The client supplies a canonical task ID already present in the thread's active-agent projection; the Prime adapter resolves it only through its private authoritative descendant roster before calling public `watchSession`. Concurrent subscribers for the same child and native endpoint share one reference-counted read-only native attachment, while revisions and lifetime quotas remain subscriber-local. The server sanitizes the initial committed messages and Prime's public replacement, resync, message-stream, and tool-execution events into bounded replacement snapshots. The existing `entries` field remains assistant-only for older clients; timeline-aware clients read the additive `activity` field, which contains only non-empty assistant text or a coarse tool row with a fixed safe label, subscriber-local numeric activity ID, and `started`/`completed`/`failed` status. Native tool IDs are immediately reduced to attachment-salted correlation digests and never enter sanitizer state or a wire value; tool arguments, partial and final results, reasoning, paths, timestamps, native metadata, and error text are never read or copied into the sanitizer state. Exact known tool names map to fixed labels (`ipython` and `functions.ipython` become **Code**) and unknown names become **Tool**. A bounded tool skeleton is hydrated from public committed messages when call/result correlation is safely available. Child prompts, system/developer messages, attachments, usage, native identities, and envelopes otherwise terminate at the Prime boundary. Snapshot size, entry count, update count, lifetime characters, initialization events, and concurrent watchers are hard-capped. Watcher events are sanitized before bounded initialization admission, preserving the subscribe-before-read race without retaining native payloads. Duplicate snapshots are suppressed and assistant event bursts are debounced. No runtime event or orchestration activity is created, and durable child lifecycle projections discard native answer previews, recaps, and errors, so neither SQLite nor clients without an open view receive the assistant text. Stream finalizers close the shared watcher after its last panel owner leaves, or immediately on WebSocket cancellation, roster settlement/removal, endpoint replacement, session stop, provider replacement, or scope shutdown. Prime Agent 0.8.1 can attach only to a currently live child and exposes neither an atomic history cursor nor reopen for exited children; capability and UI wording therefore promise only **Live activity**, never a durable or lossless transcript.

Quick questions use a separate operate-scoped unary RPC and never enter provider runtime ingestion or orchestration. The per-WebSocket handler owns a Pylon request ID, while the Prime adapter maps it to an unguessable native ID and accepts only exact correlated terminal events. It returns one answer after completion; prompt text, cumulative native updates, errors, IDs, and lifecycle never cross into durable state or other Pylon clients. Questions and answers have UTF-8 and character bounds, cumulative native traffic and updates are capped, and at most one question per thread plus a provider-wide concurrency limit can run for two minutes. Cancellation, timeout, request interruption, WebSocket disconnect, session replacement, and scope shutdown run one best-effort native abort without retry. Because Prime 0.8.1 side agents inherit provider extension hooks even with `tools: []`, this operation is admitted only in fresh supervised sessions where discovery is disabled and Pylon's verified permission extension cannot act on a tool-free response. Full-access, restored, and ACP sessions fail closed.

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
composer control. Prime Agent 0.8.1 exposes no corresponding daemon methods for create, update,
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

## OpenCode server ownership and catalog

Each OpenCode provider instance owns one lazy local server for catalog discovery and
text-generation helpers through [`OpenCodeServerOwner.ts`][opencode-server-owner]. Concurrent
borrowers share startup. The server closes 30 seconds after the last borrower releases it, or
when the provider instance closes. A failed or exited process can be started again on the next
use. An externally configured OpenCode server remains externally owned.

The local server and its SDK clients use one resolved password. An explicit provider password
overrides `OPENCODE_SERVER_PASSWORD` in the spawned environment. Without an explicit password,
the client uses the password from the environment that the process inherits. External servers use
only their explicit provider password and never inherit the host's local password.

Every server connection must pass the authenticated `/global/health` check before inventory or
session operations start. The response must contain a valid version at or above 1.14.19. Local
owners cache this result for the lifetime of the spawned process. External actions check once when
they create their server connection, not for each model or SDK request.

Chat adapters keep their own server per thread. They register a thread-specific `t3-code` MCP
connection, while OpenCode stores MCP connections by directory. Sharing these chat servers
without changing MCP routing would let two threads in one directory replace each other's
connection.

OpenCode loads its catalog through the HTTP API when an enabled provider instance starts. The
provider registry keeps the snapshot in memory and persists it in the existing per-instance cache.
Each `subscribeServerConfig` connection refreshes all providers, so a client reconnect reloads the
OpenCode catalog from the current helper. The `serverRefreshProviders` request also refreshes it.
Periodic OpenCode probes remain disabled. OpenCode reads credentials for each inventory request,
but its native configuration files can remain cached for the lifetime of the helper process. The
helper closes 30 seconds after its last inventory or text-generation borrower releases it. A
refresh after that idle period starts a new helper and reads file changes. Repeated refreshes and
active text-generation work can extend process reuse. Changes to the provider configuration or
environment replace the instance and start a new discovery. Changes to unrelated settings only
update snapshot enrichment. Other providers retain their existing refresh policy.

Pylon does not own an external OpenCode process. Native configuration changes there can require
an external reload or restart before Pylon's next refresh sees them.

The shared server's idle shutdown does not clear the catalog. Failed discovery keeps the last
known models, slash commands, and skills through the registry's existing merge rules. A successful
empty inventory is authoritative. Existing threads keep their explicit model identifier and
options when catalog metadata is missing; the catalog is not permission to choose a different
model for a thread.

## Model manifest

The model picker's legacy section is driven by `apps/server/src/provider/model-manifest.json`, which
lists the current (non-legacy) model slugs per driver kind. The `ModelManifest` service
(`apps/server/src/provider/ModelManifest.ts`) refreshes that data from
`pylon-code/pylon-releases` via raw.githubusercontent.com, so moving a model in or out of the legacy
section does not need a product release. Preference order is remote fetch, then the on-disk copy of the last successful fetch (in
the state directory), then the bundled copy. Fetches are TTL-gated, run concurrently with provider
probes, respect the `enableProviderUpdateChecks` setting, and never fail a provider check. The
Codex and Claude drivers apply the classification to every snapshot with `applyModelManifest`;
driver kinds absent from the manifest have no legacy concept.

## Subscription capacity

Each Codex and Claude snapshot may carry `usageLimits`: the account's rolling session and weekly
windows as `usedPercent` plus a reset time. Three mechanisms keep that gauge present and current:

- **Polled reading.** The driver's status probe reads it — Codex through the app-server's
  `account/rateLimits/read`, Claude through Anthropic's OAuth usage endpoint
  ([`claudeOAuthUsage.ts`][claude-usage]). The probe runs on the provider-health interval while a
  client holds foreground provider-status demand, and again as soon as demand returns to a snapshot
  older than that interval ([`makeManagedServerProvider.ts`][managed]). A failed read keeps the last
  good reading for up to thirty minutes rather than blanking the gauge
  ([`providerUsageRetention.ts`][retention]).
- **Pushed updates.** A running session reports its windows mid-turn — Codex's
  `account/rateLimits/updated`, Claude's `rate_limit_event` with `utilization` — as the
  `account.rate-limits.updated` runtime event. Ingestion parses them
  ([`providerRateLimitEvents.ts`][rate-limit-events]) and hands them to
  `ProviderRegistry.mergeProviderUsageWindows`, which keeps them as a volatile overlay and re-applies
  every push newer than the probe reading on top of each snapshot
  ([`providerUsageLimits.ts`][usage-limits]). A probe that runs after a push supersedes it. The same
  Claude event also carries the allowed/rejected verdict that drives account-drain routing
  (`ServerProvider.rateLimit`); the two are parsed independently.
- **Nothing persisted.** Both overlays are re-learned after a restart from the next probe or push;
  the on-disk snapshot cache deliberately drops `usageLimits`.
- **Request budget.** Both usage endpoints answer 429 when hammered, and one machine routinely
  runs several servers against one account — the installed app plus worktree dev servers. A good
  Claude reading is therefore shared machine-wide for five minutes
  ([`sharedUsageReadCache.ts`][shared-usage]): it lives in the user's cache directory
  (`~/Library/Caches/pylon-code/usage`, `%LOCALAPPDATA%\pylon-code\Cache\usage`,
  `$XDG_CACHE_HOME/pylon-code/usage`; override with `PYLON_USAGE_CACHE_DIR`), deliberately outside
  any runtime home, keyed by the account's config dir. Each server's in-memory cache holds a
  reading only for the rest of the shared window, a lock file makes the endpoint read once when
  several servers expire together, and a 429 is written as a shared deadline (its `Retry-After`,
  bounded to 1–30 minutes, five by default) that every server honours. Codex reads inside its
  status probe, which runs at most once per refresh interval per server. Pushed updates cost
  nothing outbound, and a push that repeats the current number is folded in at most once a minute
  so a busy turn cannot republish the provider list per tool call. Clients only offer a manual
  refresh once a reading is older than the shared window. Codex's rate-limit read shares the same
  file under its own key, so several servers on one Codex home also read it once per window.
- **Agents that sign in on their own.** Prime Agent runs models on Anthropic or OpenAI Codex with
  credentials of its own, so its snapshot carries `backends`
  ([`primeAgentBackends.ts`][prime-backends]): for OpenAI Codex the ChatGPT account id, which a
  configured Codex instance also reports as `auth.accountId`
  ([`codexAccountIdentity.ts`][codex-identity]), plus — while Prime's token is fresh — Prime's own
  reading: Anthropic through the usage endpoint, ChatGPT through a throwaway Codex app-server in an
  empty scoped home, signed in with `chatgptAuthTokens` (access token and account id only, never the
  refresh token). The throwaway process has the same two-second force-kill escalation as the Codex
  status probe and a five-second whole-read timeout, leaving three seconds inside the periodic
  provider's outer budget after worst-case process escalation. It deliberately stays inside the Prime
  boundary rather than reaching into another provider instance's configuration, so `codex` must be
  available on the server process's `PATH`; failures emit only a prerequisite/reason diagnostic,
  never credentials or native process output. Both backends go through the shared cache under
  Prime's own keys; Anthropic keys and retention overlays include only a one-way access-token
  fingerprint, so a re-login cannot inherit another credential's reading and no fingerprint crosses
  the wire. A failed Prime-owned read adds a thirty-second shared marker while preserving the newest
  same-identity entry for at most thirty minutes, so other server processes do not immediately repeat
  it. Prime only refreshes a
  backend's token while running a turn on it, so `ProviderInstance.capacity` re-reads the backends
  when a turn completes on the instance (`ProviderRegistry.refreshProviderCapacity`, floored to one
  read per instance per minute, off the ingestion path); the periodic probe covers the rest. Clients
  show a Prime thread the capacity Prime is verified to use — its own reading, or the Codex instance
  whose account id matches — and fall back to the configured accounts labelled as assumed only when
  neither can be read.

Windows are matched by duration, never by label: anything under a day is the session window,
anything of a week or more is a weekly, and the first weekly is the account-wide one. That is what
lets one strip and one popover render Codex and Claude the same way.

## Attachment access

The server stores uploaded attachments in its attachment directory, outside the project workspace.
`ProviderService` adds the absolute path of each attachment to the turn text, then passes every
attachment to the provider adapter. Each adapter decides what its provider ingests natively:

- Codex, Claude, Cursor, Grok, and Prime Agent send images as native image inputs and skip generic
  files. For these providers, generic files reach the agent only as file paths in the turn text.
- OpenCode sends PNG/JPEG/GIF/WebP images, text files, and PDFs up to 20 MB as native file parts
  with their real mime type. Everything else (ZIP and other binaries, image formats model APIs
  reject, oversized files) falls back to the file path in the turn text, like the other providers.

Claude receives the attachment directory as an allowed additional directory. Codex keeps its
configured sandbox policy, so access depends on that policy and the selected runtime mode. OpenCode
allows all paths in full-access mode and requests approval for directories outside the workspace in
restricted modes. Cursor and Grok use their own provider permission rules.

The server does not copy attachments into a project or bypass provider approval rules. If an agent
cannot read an attachment, the user must approve the access or select a runtime mode that permits it.

Updated attachment schemas tolerate unknown attachment members, but old image-only clients still
cannot decode messages that contain file attachments. Client file-picking rollouts must account for
this limit.

Do not run an old image-only server against state that contains file attachments. Replay decodes
each persisted event before projection. A file-bearing event can make `ProjectionPipeline` bootstrap
and `OrchestrationEngine` startup fail for the entire environment, not only the affected thread.

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
[opencode-server-owner]: ../../apps/server/src/provider/OpenCodeServerOwner.ts
[prime]: ../../apps/server/src/provider/Drivers/PrimeAgentDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[claude-usage]: ../../apps/server/src/provider/claudeOAuthUsage.ts
[managed]: ../../apps/server/src/provider/makeManagedServerProvider.ts
[retention]: ../../apps/server/src/provider/providerUsageRetention.ts
[rate-limit-events]: ../../apps/server/src/provider/providerRateLimitEvents.ts
[usage-limits]: ../../apps/server/src/provider/providerUsageLimits.ts
[shared-usage]: ../../apps/server/src/provider/sharedUsageReadCache.ts
[prime-backends]: ../../apps/server/src/provider/primeAgentBackends.ts
[codex-identity]: ../../apps/server/src/provider/codexAccountIdentity.ts
