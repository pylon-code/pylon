# Product analytics

The server owns PostHog delivery, opt-out, and identity. Clients do not load the PostHog browser
SDK. [AnalyticsService](../../apps/server/src/telemetry/AnalyticsService.ts) ships with no project
key, so a stock Pylon server records and sends nothing. Setting `T3CODE_POSTHOG_KEY` to a
Pylon-owned project enables delivery; `T3CODE_TELEMETRY_ENABLED=false` disables it again even when a
key is present. [Identity selection](../../apps/server/src/telemetry/Identify.ts) hashes an
available provider account ID, falling back to an installation-scoped ID. This identity can span
several clients; it does not identify a browser session.

## Provider turn events

`provider.turn.sent` records an accepted send request. `provider.turn.completed` records one event
per provider instance, thread, and turn when the provider emits a completed or aborted turn.
[ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts) correlates each send
with the turn ID the adapter returns and holds a completion that arrives before that response.
Session start and stop, `session.exited`, a thread moving to another provider instance or adapter
generation, and server shutdown flush held completions, including when an adapter owns its own
shutdown. Duplicate terminal events are recorded once. Analytics observe only events that already
passed the runtime generation and session incarnation fences.

Send and completion counts need not match. Providers can emit synthetic turns without a send
request. Collection is best effort, with no scan or backfill of provider history.

## Interpreting token usage

Token totals cover the main agent. `inputTokens` includes uncached input, cache reads, and cache
writes; `outputTokens` includes reasoning, and cache and reasoning counts are subsets of those
totals. `complete` usage has whole-turn totals. `partial` usage contains valid observed counts but
cannot establish a whole-turn total, for example after an interruption, failure, or reconnect.
`unavailable` means the provider supplied no trustworthy counts. Unknown counts stay absent rather
than zero. Keep these distinctions when changing token normalization or building reports.

Codex usage is the delta of the thread's cumulative totals, falling back to the newest response's
own usage when no prior total exists or the total shrank. Claude uses the final result's per-turn
usage, never cumulative model usage. OpenCode sums unique step totals from assistant messages
answering the turn's prompts, and a step whose owning message is unresolved makes the turn partial.
Cursor, Grok, Antigravity, and Prime Agent report usage as unavailable until their token fields and
scope are verified.

Child agents and model rerouting prevent a turn from representing one provider/model combination's
full cost; `hasSubagents` and `mixedModels` mark those turns. For provider comparisons, require
complete usage, no observed subagents, and no mixed models; compare matching model, effort,
interaction mode, and terminal status. Aggregate output/input ratios should divide the summed
totals. Averaging per-turn ratios lets small-input turns dominate.

## Collection boundary

Keep analytics payloads to product metadata and normalized measurements. Do not send prompts,
responses, authentication material, raw provider payloads, user-assigned device names,
conversation identifiers, provider instance IDs, or child-agent output. PostHog person profiles
remain disabled.
