# Prime Agent

Pylon can run [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) as a provider on the
device that owns your environment. Prime Agent is not bundled with Pylon.

## Install And Sign In

Install Prime Agent on the environment host. Prime Agent requires Node.js 22.8 or newer:

```bash
npm install --global prime-agent@0.7.1
```

The Early Access integration is tested with Prime Agent 0.7.1. Start it once in a terminal and use `/login` to configure an underlying model provider:

```bash
prime-agent
```

Pylon uses the existing Prime Agent login. It does not currently offer Prime Agent sign-in inside
the app.

## Configure Pylon

Open **Settings → Providers**. The default provider normally needs no changes:

```text
Display name: Prime Agent
Binary path: prime-agent
Agent home path: empty
Launch arguments: empty
```

An empty **Agent home path** uses Prime Agent's normal `~/.prime/agent` directory. Set it only
when this provider instance should use a separate Prime Agent home. If the app cannot find a CLI
installed outside the system path, set **Binary path** to the complete path of `prime-agent`.

Pylon normally uses Prime Agent's native daemon API. A non-empty **Launch arguments** value selects
ACP compatibility mode instead, because the daemon API cannot safely preserve arbitrary CLI
arguments. Pylon shows that fallback in the provider status rather than silently discarding the
arguments.

Pylon uses a short-lived, prompt-free Prime Agent RPC process to discover configured models.
Model names keep their underlying provider qualifier, such as `anthropic/...` or `openai/...`.
**Prime Agent Default** lets Prime Agent use its configured or restored default instead of forcing a
model. Selecting a discovered reasoning model adds its supported thinking levels to the composer.
Eligible OpenAI Codex models also expose **Standard** and **Fast** service tiers. These choices apply
when the next message starts; they cannot be changed by a steering message after a run has begun.

While a daemon-backed turn is working, sending another message steers the same turn. The separate
**Queue follow-up** action admits the current draft for the next native run instead. Pylon shows only
privacy-safe steering and follow-up counts; it never sends queued prompt previews to clients. The
**Session inputs** control clears pending inputs without interrupting current work, while stopping the
turn aborts current work and clears the native queue atomically. A queued follow-up remains in the
conversation as your durable intent; if admission fails, Pylon marks it as not queued. Clearing session
inputs does not erase conversation history. On mobile, these shared session inputs
remain separate from pending sends saved on that device. Native select, confirm, input, and editor dialogs appear in
the session panel; notifications, status, and widgets use the same provider-neutral presentation
surface. In Full access, the slash-command menu also shows the safe command names, descriptions, and
argument hints loaded for that thread when its native session starts, including prompt and skill commands.
While the session is idle, the refresh control reloads Prime's settings, authentication, MCP configuration,
resources, runtime, and extension lifecycle before replacing the visible command catalog. It is intentionally
unavailable in Supervised mode. If the reload cannot finish safely, Pylon clears the catalog and closes that
native session rather than risking a partially reloaded runtime; it never retries automatically. Pylon does not
send resource paths, diagnostics, or extension source details
to clients. Supervised sessions keep discovered commands disabled. Observed Prime subagents appear in Pylon's Agents hierarchy. In Full access, an active agent can be stopped from its Agents row on web or desktop, or from the **Agents** control on mobile. Pylon waits for Prime's native cancelled status instead of marking the agent stopped optimistically; completed output and activity remain in the thread. A cancellation racing natural completion is treated as already settled, and Pylon never retries an uncertain cancellation automatically. Supervised sessions do not offer this control because child-agent spawning is disabled. When the selected model explicitly
exposes reasoning text, Pylon adds a bounded final **Reasoning** entry to the work log. Incremental
thinking deltas and provider-private reasoning metadata are not persisted.

Daemon-backed threads also show Prime's current context-window estimate and selected model limit in
the composer. The meter is separate from per-turn token totals and hides when Prime reports the
post-compaction context as unknown; it returns after the next successful model response. Pylon uses
the session's native automatic-compaction setting rather than assuming compaction is enabled.

Daemon-backed sessions also expose an **Agent spawn depth** control while the session is idle. Depth
0 disables recursive child-agent spawning; depths 1 through 4 bound how many nested levels Prime may
create. The choice applies only to that native session and never changes Prime's global setting.
Supervised sessions show the policy-fixed depth 0 and cannot change it.

When Prime compacts a daemon-backed thread, Pylon shows one provider-neutral lifecycle row. Pylon
stores only constant started, completed, skipped, or failed presentation state; Prime's compaction
instructions, generated summary, and native errors are not copied into Pylon's event store or
remote clients. Prime still keeps the native compaction record in its private transcript for exact
resume.

Automatic provider retries and Prime harness refinements also appear as provider-neutral work rows.
Retry error text and refinement proposals, summaries, native IDs, paths, and edit details are not
copied to Pylon. A refinement that applies some changes and rejects others is shown as partially
applied rather than wholly failed.

Completed daemon turns can show a **Reported cost** beside the terminal reply. This is Prime's
model-pricing estimate for that turn as reported at completion, not an invoice or account-wide
billing total. Very small estimates remain visible instead of rounding to zero; a reported zero can
also mean the selected model has no registered price.

## Execution Approvals

Daemon-backed threads support **Supervised** and **Full access**. Supervised mode loads a
Pylon-managed gate that pauses supported built-in edits, shell commands, and IPython cells before
execution. You can approve one call, approve calls for the rest of that session, decline the call,
or cancel the turn. Inputs that are too large to show completely and tools whose arguments Pylon
cannot review completely are denied. A missing gate, invalid request, timeout, disconnect, or failed
response blocks execution instead of falling back to full access.

Supervised mode deliberately disables discovered Prime extensions, Prime slash commands, and Prime
subagent spawning. Extensions and slash commands are executable host code that cannot be contained
by the tool gate; child sessions also need their own independently verified gate. Full-access
threads keep normal Prime extension discovery, commands, and subagents.

This is an approval gate, not a sandbox. An approved IPython cell or shell command has the same host
access as Prime Agent, including access outside the workspace and the ability to start processes or
use the network.

Daemon-backed threads resume the exact Prime transcript selected for that Pylon thread. If the saved
transcript is removed or its private identity cannot be verified, Pylon reports a resume failure
instead of silently opening a blank or merely recent Prime session.

## Current Limitations

- Prime Agent 0.7.1 has no daemon-native or operating-system sandbox policy. Supervised mode gates
  tool admission but does not restrict an approved tool.
- Authentication is managed in Prime Agent, not Pylon.
- Plan mode, provider-conversation rollback, per-item queue editing or reordering, and Pylon's
  per-thread MCP bridge are not supported yet.
- Pylon does not yet present live Prime reasoning streams, cost breakdowns, goals, heartbeats,
  saved-session history, or native package or MCP catalogs as first-class features.
- Prime Agent is not used for Pylon's background text-generation helpers in Early Access.
- ACP compatibility mode is intentionally narrower: it hides daemon-only thinking and service-tier
  controls, cannot steer or switch models in a running session, supports only Full access, and does
  not expose native session UI or subagent hierarchy.

Remote web and mobile clients work normally: Prime Agent runs on the environment host, not on the
device displaying Pylon.
