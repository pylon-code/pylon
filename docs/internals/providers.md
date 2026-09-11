# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/provider/Services/ProviderAdapter.ts). Normalize there
instead of spreading provider checks through reactors and clients.

A driver kind identifies an integration; an instance identifies one configuration and account
lifecycle. Route work by instance, so two accounts using the same driver do not share mutable
session or catalog state.

## Process and account isolation

Pylon-managed OpenCode chat uses one server per thread. Its MCP registrations are directory-scoped,
while Pylon's MCP connection is thread-scoped. Sharing a chat server between threads in one
directory would let them replace each other's connection. Catalog and text-generation work can
share the [instance-owned helper](../../apps/server/src/provider/OpenCodeServerOwner.ts), which
closes 30 seconds after its last borrower. External OpenCode servers remain externally owned, use
only their explicit provider password rather than the host's, and can require an external restart
to pick up configuration changes.

OpenCode also stores persistent approval grants per directory. Automatic full-access replies use
`once` so they cannot widen a supervised thread's permissions on a shared external server.
See the [adapter](../../apps/server/src/provider/Layers/OpenCodeAdapter.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

The [Antigravity installer](../../apps/server/src/provider/AntigravityInstallation.ts) outlives
client connections and provider-instance rebuilds. Releases are immutable, with an atomic pointer
selecting the version for new processes. Running processes hold leases on their version. Updates
and removal must respect those leases instead of replacing executables under a running agent.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login browser.
[Grok probes](../../apps/server/src/provider/Layers/GrokProvider.ts) avoid authentication and
session creation for this reason. Antigravity likewise reserves authenticated catalog sessions for
explicit setup or model refresh; background checks use initialization only. Prime Agent never
creates a session only for model discovery.

[Antigravity sign-in](../../apps/server/src/provider/AntigravityAuth.ts) belongs to the initiating
Pylon auth session. The client carries the return URL back to the environment because the provider's
loopback listener may be on another machine. Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished. The native
process owns token exchange and storage.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing
account metadata. Otherwise a helper or resumed session could retain the old account. Cached model
lists do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider updates run only through the owning installer

A one-click update is offered only when the resolved executable's path proves which installer owns
it. Homebrew and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global bin directories of pnpm, Bun, and Vite+ may match on either
the resolved path or its real target, since those installers place real files or their own symlinks
there. Anything unproven stays manual-only but still reports the version gap. npm updates pin
`--prefix` because the `npm` on `PATH` can belong to a different Node than the one that owns the
provider. Homebrew compares against `brew info` since casks trail npm by hours; native installs
share npm's version train, so the registry stays authoritative for them.
See the [resolver](../../apps/server/src/provider/providerMaintenance.ts).

Ownership is cached per instance and re-read immediately before an update runs. The
[runner](../../apps/server/src/provider/providerMaintenanceRunner.ts) refuses when the lock key
changed since the advisory, and refreshes the provider before reporting success. A readable version
must meet the target; a missing version after a successful install remains an unknown version, as
Cursor's transient probe behavior requires. Prime Agent keeps its managed-distribution inspection
and manual maintenance instead.

## Protocol traps

Codex async questions arrive as notifications and are answered with a new user message. There is
no pending RPC response to send. Blocking questions still use the request/response path. The
[adapter](../../apps/server/src/provider/Layers/CodexAdapter.ts) distinguishes them; the
[decider](../../apps/server/src/orchestration/decider.ts) records an async answer and its user
message together.

An async question can outlive the turn or a server restart. The engine reads that request's
durable activity before resolving it because the in-memory command snapshot omits old activities.
Do not infer that a request has disappeared merely because it is outside the recent window.

Capabilities must describe what the provider can actually do. Antigravity can capture workspace
checkpoints but cannot roll back its conversation. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
therefore rejects revert before touching files. Native permission and question option IDs must
also survive normalization; a display label is not necessarily a valid reply.

Runtime guidance identifies Pylon and the harness without changing the stored user message.
Claude's session-level guidance omits model and effort because they can change during a session,
and OpenCode variants are not assumed to be reasoning-effort levels. Prime Agent keeps its native
managed instructions and submitted prompt unchanged: daemon admission recovery compares the exact
submitted text and attachments with Prime's user-message completion, so any Prime runtime guidance
must use a supported native instruction hook that preserves that proof.

## Turn admission and session incarnations

`thread.turn.start` records a durable pending admission before the provider call begins: the
command ID, message ID, a server-observed request time and deadline, and the provider session
incarnation once a session is bound. The
[provider command reactor](../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts)
restores these records at startup and either observes the matching `turn.started` or dispatches one
correlated failure after the deadline. Client-supplied `createdAt` values never extend it.

Adapters carry the admission command ID and provider-session start time from `sendTurn` to the
exact `turn.started` event, and runtime ingestion accepts a start for a durable admission only when
both match. A completion, timeout, retry, or stop clears the pending record, so a late event cannot
revive an old request. Older projected sessions without an incarnation remain readable; their
uncorrelated runtime events are accepted only while a matching pending turn row exists, or from an
idle legacy session with no pending turn. Migration backfill joins a pending turn to one
unambiguous historical request and leaves ambiguous rows unset.

A server restart leaves the projection holding the incarnation of a runtime that no longer exists.
Prime restart adoption re-attaches the persisted incarnation itself. For every other provider, the
[startup continuation](../../apps/server/src/serverRuntimeStartup.ts) starts the session, binds the
recovered incarnation to the projection as an idle running session, and only then sends the
continuation turn, so its uncorrelated `turn.started` is admitted as provider-initiated. An error
settle after that point keeps the recovered incarnation. Skipping the bind fences every runtime
event from the recovered session and fails later user turns with an incarnation mismatch.

## Exact conversation rollback

The optional `absoluteConversationRollback` adapter boundary captures, inspects, applies, and
releases a private JSON anchor with a stable equality digest. The durable
[rollback saga](./rollback-recovery.md) accepts only an adapter that declares
`conversationRollback: "absolute"`, implements every operation, and reports the exact thread
available. Relative turn counts and uninspectable no-op paths fail closed. The managed native Prime
daemon is the only built-in implementation; its anchor, navigation, and quarantine rules are in the
[daemon parity ledger](./prime-agent-daemon-parity.md). Anchors, native identities, and receipts
never enter orchestration events, logs, telemetry, or client payloads.

## Subscription capacity

Codex and Claude snapshots may carry `usageLimits`: the account's rolling session and weekly windows
as `usedPercent` plus a reset time. Windows are matched by duration, never by label: anything under
a day is the session window, anything of a week or more is a weekly, and the first weekly is the
account-wide one. That lets clients render every provider's windows the same way.

- **Polled readings.** The driver's status probe reads the windows, Codex through the app server's
  `account/rateLimits/read` and Claude through Anthropic's
  [OAuth usage endpoint](../../apps/server/src/provider/claudeOAuthUsage.ts). The probe runs on the
  provider-health interval while a client holds foreground provider-status demand, and again when
  demand returns to an older snapshot
  ([managed provider](../../apps/server/src/provider/makeManagedServerProvider.ts)). A failed read
  keeps the last good reading for up to thirty minutes
  ([retention](../../apps/server/src/provider/providerUsageRetention.ts)).
- **Pushed updates.** Running sessions report windows mid-turn, Codex through
  `account/rateLimits/updated` and Claude through `rate_limit_event`. Ingestion
  [parses them](../../apps/server/src/provider/providerRateLimitEvents.ts) into a volatile overlay
  that `ProviderRegistry.mergeProviderUsageWindows` re-applies on top of each older probe reading
  ([usage limits](../../apps/server/src/provider/providerUsageLimits.ts)). The same Claude event
  carries the allowed or rejected verdict that drives account-drain routing; the two are parsed
  independently.
- **Nothing persisted.** Both overlays are re-learned after a restart; the on-disk snapshot cache
  drops `usageLimits`.
- **Request budget.** Both usage endpoints answer 429 when hammered, and one machine often runs
  several servers against one account. A good Claude reading is shared machine-wide for five minutes
  through the [shared read cache](../../apps/server/src/provider/sharedUsageReadCache.ts) in the
  user's cache directory (`~/Library/Caches/pylon-code/usage`, `%LOCALAPPDATA%\pylon-code\Cache\usage`,
  or `$XDG_CACHE_HOME/pylon-code/usage`; override with `PYLON_USAGE_CACHE_DIR`), deliberately outside
  any runtime home and keyed by the account's config directory. A lock file makes the endpoint read
  once when several servers expire together, and a 429 becomes a shared deadline (its `Retry-After`,
  bounded to 1–30 minutes, five by default) that every server honours. Codex's rate-limit read
  shares the same file under its own key. A pushed update that repeats the current number is folded
  in at most once a minute, so a busy turn cannot republish the provider list per tool call. Clients
  offer a manual refresh only once a reading is older than the shared window.
- **Agents that sign in on their own.** Prime Agent runs models on Anthropic or OpenAI Codex with
  its own credentials, so its snapshot carries
  [`backends`](../../apps/server/src/provider/primeAgentBackends.ts): the ChatGPT account ID for
  OpenAI Codex, which a configured Codex instance also reports
  ([identity](../../apps/server/src/provider/codexAccountIdentity.ts)), plus Prime's own reading
  while its token is fresh. Anthropic goes through the usage endpoint; ChatGPT goes through a
  throwaway Codex app server in an empty scoped home, signed in with the access token and account ID
  only, never the refresh token. That process has the Codex status probe's two-second force-kill
  escalation and a five-second whole-read timeout, stays inside the Prime boundary rather than
  reading another instance's configuration, and needs `codex` on the server's `PATH`; failures emit
  only a prerequisite or reason diagnostic. Prime-owned readings use the shared cache under their
  own keys, whose Anthropic entries include only a one-way access-token fingerprint, so a re-login
  cannot inherit another credential's reading and no fingerprint crosses the wire. A failed read
  adds a thirty-second shared marker while preserving the newest same-identity entry for up to
  thirty minutes. Prime refreshes a backend token only while running a turn on it, so a completed
  turn re-reads that instance's backends at most once a minute, off the ingestion path. Clients show
  a Prime thread the capacity Prime is verified to use, its own reading or the Codex instance whose
  account ID matches, and fall back to configured accounts labelled as assumed only when neither can
  be read.

## Attachments and stored history

Attachments live outside the project workspace. [ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
puts their environment-local paths in turn input and lets adapters choose native input formats.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary. SnapShot
metadata reaches the provider as fenced, untrusted captured-window data, never as instructions.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

## Prime Agent

Prime Agent uses its public detached-daemon APIs as the primary runtime on macOS, Linux, and WSL2,
with ACP as an explicit compatibility fallback for custom launch arguments or failed daemon setup. A
native Windows server fails closed before any probe and never falls back to ACP; Windows desktop
packaging is independent of that provider-runtime support. Multiple enabled Prime instances stay
disabled until their graduation matrix passes. One scoped daemon belongs to a provider instance,
while each Pylon thread owns an isolated native session directory.

Prime-native events terminate at the adapter boundary and map to provider-neutral runtime
contracts. Daemon identifiers, sockets, paths, request IDs, prompts, and native payloads never cross
it, and clients gate controls on the session's advertised capabilities rather than the provider
name. The [daemon parity ledger](./prime-agent-daemon-parity.md) records each public API outcome and
the boundary rules for session controls, background writing, agents, and live child activity.
[Managed installation](./prime-agent-managed-install.md) and
[distribution verification](./prime-agent-distribution-verification.md) cover how Pylon selects
and proves a build.

Model classification has its own [manifest constraints](./model-manifest.md). Assistant-reference
handling is documented under [citations](./assistant-citations.md).
