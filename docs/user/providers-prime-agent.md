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

While a daemon-backed turn is working, sending another message steers the same turn. Stopping the
turn also clears queued steering input. Native select, confirm, input, and editor dialogs appear in
the session panel; notifications, status, and widgets use the same provider-neutral presentation
surface. Observed Prime subagents appear in Pylon's Agents hierarchy.

## Current Limitations

- Prime Agent runs with full access. Prime Agent 0.7.1 has no daemon-native sandbox policy, and Pylon
  does not advertise approval-required mode.
- Authentication is managed in Prime Agent, not Pylon.
- Plan mode, provider-conversation rollback, queue inspection and follow-up controls, and Pylon's
  per-thread MCP bridge are not supported yet.
- Pylon does not yet present Prime reasoning streams, cost breakdowns, context compaction, goals,
  heartbeats, saved-session history, or native resource catalogs as first-class features.
- Prime Agent is not used for Pylon's background text-generation helpers in Early Access.
- ACP compatibility mode is intentionally narrower: it hides daemon-only thinking and service-tier
  controls, cannot steer or switch models in a running session, and does not expose native session
  UI or subagent hierarchy.

Remote web and mobile clients work normally: Prime Agent runs on the environment host, not on the
device displaying Pylon.
