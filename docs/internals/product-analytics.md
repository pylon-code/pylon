# Product analytics

> For maintainers. Using Pylon? See [docs/user](../user/).

The server owns PostHog delivery, opt-out, and identity. Clients do not load the
PostHog browser SDK. [AnalyticsService](../../apps/server/src/telemetry/AnalyticsService.ts)
ships with no project key, so a stock Pylon server records and sends nothing.
Setting `T3CODE_POSTHOG_KEY` to a Pylon-owned project enables delivery;
`T3CODE_TELEMETRY_ENABLED=false` disables it again even when a key is present.
[Identity selection](../../apps/server/src/telemetry/Identify.ts) hashes an
available provider account ID and falls back to an installation-scoped ID.
PostHog person profiles stay disabled.

## Provider turn events

`provider.turn.sent` records an accepted send request. `provider.turn.completed`
records one event per provider instance, thread, and turn when the provider emits
a completed or aborted turn. [ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
correlates each send with the turn ID the adapter returns before recording, and
holds a completion that arrives before that response. Session start, stop,
`session.exited`, and server shutdown flush held completions, and duplicate
terminal events are recorded once. Analytics observe only events that already
passed the runtime generation and session incarnation fences.

Send and completion counts need not match. Providers can emit synthetic turns
without a send request. Collection is best effort, with no scan or backfill of
provider history.

## Token usage

Adapters attach a normalized `tokenUsage` record to `turn.completed` and
`turn.aborted`. It counts the main agent only. `inputTokens` includes uncached
input, cache reads, and cache writes; `outputTokens` includes reasoning. Cache
and reasoning counts are subsets of those totals.

- `complete` means the provider supplied whole-turn input and output totals.
- `partial` means every included count is valid, but the turn was not fully
  observed, for example after an interruption, failure, or reconnect.
- `unavailable` means the provider supplied no trustworthy counts.

Unknown counts stay absent rather than zero. Keep these distinctions when
changing normalization or building reports.

| Provider                         | Source                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex                            | Deltas of the thread's cumulative `thread/tokenUsage/updated` totals. The newest response's `last` usage is the delta when no prior total exists or the total shrank. |
| Claude                           | The final result's per-turn `usage`, including thinking tokens. Cumulative `modelUsage` is not used.                                                                  |
| OpenCode                         | Unique `step-finish` totals from assistant messages answering this turn's prompts. Steps whose owning message is unresolved make the turn partial.                    |
| Cursor, Grok, Antigravity, Prime | Unavailable until their token fields and scope are verified.                                                                                                          |

Child agents and model rerouting keep a turn from representing one
provider/model combination's cost. `hasSubagents` and `mixedModels` mark those
turns. For provider comparisons, require complete usage, no subagents, and no
mixed models, and compare matching model, effort, interaction mode, and terminal
status. Divide summed output by summed input; averaging per-turn ratios lets
small-input turns dominate.

## Collection boundary

Keep analytics payloads to product metadata and normalized measurements. Do not
send prompts, responses, authentication material, raw provider payloads,
user-assigned device names, conversation identifiers, provider instance IDs, or
child-agent output.
