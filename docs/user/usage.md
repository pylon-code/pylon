# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. The environment filter applies to both Usage and Limits; refreshing rescans the selected connected environments and refetches model pricing so newly listed models receive a price without waiting for the daily update. On web and desktop, Pylon remembers your view, period, metric, and environment selection.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog. If a recovered environment needs a complete price, discard the pending changes, select that environment, and enter both required rates. Prices already saved elsewhere are kept.

## Subscription limits

Choose **Limits** to see remaining quota, reset times, and pace across your connected accounts. Accounts for the same provider are pooled across the selected environments; expand a pool to inspect its accounts. Limits are provider-reported subscription allowances, separate from the Usage page’s estimated token costs. Refresh to update the readings and reset countdowns.

Each window's bar has one segment per account, and an account keeps the same column across windows. Accounts are ordered by their 5-hour reset, soonest first, or by the first available window when no account reports a 5-hour limit. A gap means the account does not report that window.

In a thread, submit **/usage-limits** by itself to show the current provider’s quota above the composer without starting an agent turn. Dismiss the panel with its close control; a successful message send clears it. Provider-defined commands with the same name keep their own behavior. On mobile, use Usage → Limits before creating a thread.

When Codex reports reset credits, **Use reset** asks you to confirm before redeeming one. A confirmed result remains visible even if refreshing the balance fails. If the request’s outcome is uncertain, retrying checks the same attempt.

You can add a CLIProxyAPI hub in **Settings → Providers → Usage providers** on web or desktop, using the management URL and key for the selected environment. Its Codex and Claude quotas appear on all connected clients, including mobile. Remove the source there to stop including it. A failed source or account read is shown in Limits.
