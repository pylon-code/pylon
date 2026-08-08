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

**Launch arguments** may set Prime Agent behavior such as thinking defaults, but Pylon reserves its
ACP transport, offline, working-directory, session, continuation, and model flags.

Pylon uses a short-lived, prompt-free Prime Agent RPC process to discover configured models.
Model names keep their underlying provider qualifier, such as `anthropic/...` or `openai/...`.
**Prime Agent Default** lets Prime Agent use its configured or restored default instead of forcing a
model at launch.

## Current Limitations

- Prime Agent runs with full access. Its ACP mode does not send permission requests to Pylon, so
  approval-required mode is not available.
- Changing models requires a new thread. Prime Agent's ACP mode cannot switch models in a running
  session.
- Authentication is managed in Prime Agent, not Pylon.
- Plan mode, concurrent steering, provider-conversation rollback, and Pylon's per-thread MCP bridge
  are not supported.
- Thinking level follows Prime Agent's default or custom launch arguments; there is no in-app
  thinking control yet.
- Prime Agent is not used for Pylon's background text-generation helpers in Early Access.
- Pylon shows normal messages and tool activity. Reasoning chunks and Prime Agent-specific goals,
  heartbeats, subagents, and other native panels are not yet presented as first-class Pylon features.

Remote web and mobile clients work normally: Prime Agent runs on the environment host, not on the
device displaying Pylon.
