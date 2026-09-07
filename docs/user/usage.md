# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. The environment filter applies to both Usage and Limits; refreshing reads the selected connected environments. On web and desktop, Pylon remembers your view, period, metric, and environment selection.

## Subscription limits

Choose **Limits** to see remaining quota, reset times, and pace across your connected accounts. Accounts for the same provider are pooled across the selected environments; expand a pool to inspect its accounts. Limits are provider-reported subscription allowances, separate from the Usage page’s estimated token costs. Refresh to update the readings and reset countdowns.

In a thread, submit **/usage-limits** by itself to show the current provider’s quota above the composer without starting an agent turn. Dismiss the panel with its close control; a successful message send clears it. Provider-defined commands with the same name keep their own behavior. On mobile, use Usage → Limits before creating a thread.

When Codex reports reset credits, **Use reset** asks you to confirm before redeeming one. A confirmed result remains visible even if refreshing the balance fails. If the request’s outcome is uncertain, retrying checks the same attempt.

You can add a CLIProxyAPI hub in **Settings → Providers → Usage providers** on web or desktop, using the management URL and key for the selected environment. Its Codex and Claude quotas appear on all connected clients, including mobile. Remove the source there to stop including it. A failed source or account read is shown in Limits.
