# Jcode

Pylon can run Jcode as a provider on the device that owns your environment. Jcode is not bundled
with Pylon, and this integration is **Early Access**.

## Install

Install Jcode on the environment host.

macOS and Linux:

```bash
curl -fsSL https://jcode.sh/install | bash
```

Windows 11 (PowerShell 5.1 or newer):

```powershell
irm https://jcode.sh/install.ps1 | iex
```

Start it once in a terminal to confirm it runs:

```bash
jcode --version
```

Pylon needs Jcode `0.71.1` or newer. An older build is reported as unsupported with a prompt to
update. The Early Access integration is tested through `0.75.2`; a newer Jcode still runs, and
Pylon marks it as newer than the build it has tested rather than refusing it.

## Configure Pylon

Open **Settings → Providers → Jcode**. The default provider normally needs no changes:

```text
Display name: Jcode
Binary path: (empty — the field shows `jcode` as a greyed-out placeholder)
Inherit provider logins: on
```

### Binary path

Leave **Binary path** empty to use `jcode` from the server's `PATH`.

The desktop app launches its bundled server from a graphical session, and a graphical session
often has a shorter `PATH` than your terminal. If `jcode` runs in your terminal but Pylon reports
the provider as not installed, set **Binary path** to the complete path of the executable. `which
jcode` in your terminal prints it.

The same applies on Windows. If Pylon cannot launch Jcode, set **Binary path** to the full path of
the Jcode executable rather than relying on `PATH`. `where.exe jcode` in a terminal prints it.

### Inherit provider logins

Jcode signs in to the underlying model provider itself. Pylon does not offer Jcode sign-in inside
the app.

**Inherit provider logins** on: the Jcode instance can read recognized credential files already on
the host, so it works with the accounts you are signed in to. Turning it on means Jcode turns can
spend those accounts' quota and count against their rate limits, including quota you are also
using elsewhere.

**Inherit provider logins** off: the instance starts with no inherited host credentials and must
be given its own. Use this to keep a provider instance's usage separate from your everyday
accounts.

The setting applies per provider instance, so you can run one inherited instance and one isolated
instance side by side.

## Execution

Jcode threads run in **Full access** only. Jcode has no way to gate individual tools before they
run, so Pylon does not offer **Supervised**, **Auto-accept edits**, or **Auto** for a Jcode
thread, and no approval prompts appear. A Jcode turn can run commands, edit files, reach the
network, and act outside the workspace without asking.

Full access is not an operating-system sandbox. Give Jcode work in a worktree, a container, or a
checkout you are willing to lose.

You do not have to select the mode yourself. On a Jcode thread the mode control offers **Full
access** and nothing else, and a thread that already carried a different mode — because you
switched it to Jcode, or picked the mode before choosing the provider — is moved to **Full access**
when you open it. Web and mobile both behave this way.

If a session is somehow still started in a mode Jcode cannot run, Pylon refuses it with an
explanation rather than quietly running your work under a mode you did not pick.

## Sessions and state

Each Jcode provider instance gets its own private Pylon-owned Jcode state directory, separate from
a `jcode` you run yourself in a terminal. Two Pylon instances of the provider never share state.

Each Pylon thread owns its own durable Jcode session. Pylon reopens the exact session that belongs
to that thread, so a thread you return to days later continues where it left off rather than
starting blank or resuming somebody else's conversation. If the saved session cannot be found or
verified, Pylon reports a resume failure instead of guessing.

Your conversation history in Pylon is Pylon's own record. Jcode keeps its transcript privately for
exact resume; Pylon does not copy it into the thread.

## If the connection drops mid-turn

Reconnecting during an active Jcode turn is lossy. Jcode cannot replay the part of a turn you
missed, so rather than presenting a gap as if it were continuous work, Pylon ends the affected
session instead of silently reattaching. Start the work again in the thread; the durable session
still resumes normally for the next turn.

This affects the turn in flight, not the thread. Web, desktop, and mobile clients viewing the same
thread all see the same outcome.

## What works in Early Access

- Streaming replies, with reasoning shown while it happens and kept as a summary afterwards.
- Tool activity in the work log.
- Per-turn token usage, including cached input tokens.
- Model selection from the catalog the running Jcode reports, plus thinking-effort choices.
  Switching models inside a running session is supported.
- Image attachments.
- Stopping a turn.
- Durable per-thread sessions and exact resume, as described above.
- Multiple Jcode provider instances, each with its own binary path, credentials, and state.
- Remote web and mobile clients: Jcode runs on the environment host, not on the device showing
  Pylon.

## What is not supported yet

- Recovering cleanly when a provider retries mid-answer. If the connection drops partway through a
  reply, the retried answer can appear alongside the partial one. Support for this is built and
  waiting on a Jcode release that reports the capability.
- Approvals and permission modes other than **Full access**.
- Plan mode.
- Rolling a conversation back to an earlier point, and reverting through Jcode's own history.
- Compaction controls and the context-window meter.
- Queued follow-ups and steering controls.
- Pylon-managed sign-in, account switching, and account status.
- Subagents, skills, prompts, packages, MCP, goals, schedules, and native session dialogs.
- Cost estimates and rate-limit reporting.
- Background helpers such as generated commit messages, PR descriptions, branch names, and thread
  titles. Selecting a Jcode instance for those fails with a clear message rather than quietly using
  a different provider. Pick another provider for source-control writing.
