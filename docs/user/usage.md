# Usage and limits

## Understand your usage

**Usage** combines Codex, Claude Code, and Grok Build session history from your connected
environments. It shows token use, cache savings, provider shares, model breakdowns, and estimated
API-equivalent cost. These estimates are not your subscription bill.

Totals depend on the history available on each server. Grok turns without a saved completed-turn
record are missing from the totals.

**Past 24h** shows an hourly chart of the rolling 24-hour period; **7 days**, **30 days**, and
**90 days** use daily resolution. The environment filter applies to both Usage and Limits. On web and
desktop, Pylon remembers your view, period, metric, and environment selection.

If recent work is missing or a new model shows no cost, refresh to rescan the selected environments'
session history and update model pricing.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter; choose
all environments or individual destinations. Enter the exact model ID and USD rates per million input
and output tokens, including for models without public pricing.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for tokens
that are free. Saved prices replace automatic pricing for all of that environment's history and are
shared with clients connected to it. When environments have different prices, cells show **Mixed**.
Edit rates in the table and choose **Save changes**; untouched cells keep each environment's rate.
**Reset to automatic** marks an override for removal when you save.

Each destination reports whether the change saved. Offline or unavailable environments are marked
**Not saved**; reconnect them and choose **Retry failed saves** to finish the same change without
writing again to environments that already saved. If a recovered environment needs a complete price,
discard the pending changes, select that environment, and enter both required rates. Changes are not
queued after you close the dialog.

## Track subscription limits

**Usage → Limits** shows remaining quota, reset times, and pace for your subscription accounts. It
pools accounts for the same provider across the selected environments, so you read one number per
window; expand a pool to inspect its accounts. Each window's bar has one segment per account, kept in
the same column across windows and ordered by the soonest 5-hour reset. A gap means the account does
not report that window. Refresh to update the readings.

API-key accounts may not report subscription limits. This also applies to Claude connections using a
proxy through `ANTHROPIC_AUTH_TOKEN`.

In a thread, send `/usage-limits` by itself to show the current provider's quota above the composer
without starting an agent turn. Dismiss the panel, or send a message, to clear it. Provider commands
with the same name keep their own behavior. On mobile, use **Usage → Limits** before creating a
thread.

When Codex reports banked reset credits, **Use reset** asks you to confirm before redeeming one. A
confirmed result stays visible even if refreshing the balance fails, and retrying an uncertain request
checks the same attempt.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub** on web or desktop.
Choose the environment that will connect to the hub and enter its management URL and key.

The hub's Codex and Claude quotas appear under **Usage → Limits** on all connected clients, including
mobile, and a failed hub or account read is shown there. This connection supplies usage information;
configure the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.
