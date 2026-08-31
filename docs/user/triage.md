# Triaging a Broken Install

When Pylon misbehaves — it crashes, will not start, cannot sign in, or is
mysteriously slow — you can hand the problem to a coding agent that already
knows where Pylon keeps its logs, database, and state.

```bash
npx t3@latest triage
```

The command gathers the machine facts worth knowing (installed version, OS,
whether the server is running, and the paths to logs and state), then starts a
session with `claude` or `codex` and asks you what went wrong. From there the
agent investigates, tries to unblock you, and offers to turn what it found into
a well-written issue.

Pick the agent explicitly when you have both installed:

```bash
npx t3@latest triage --agent codex
```

You stay in control. The agent asks before running any fix, and always shows
you the complete issue text before it files anything.

## What it will not do

- It never reads your secrets directory.
- It scrubs API keys, tokens, pairing credentials, and your home directory path
  out of anything it quotes.
- It only writes to the database when a write is the fix you asked for, and
  only after you say yes.

Screenshots help a lot. Paste them into the session — though you will need to
drag them into the issue yourself afterwards, since they cannot be attached
from the terminal.

## Where issues go

By default, triage does not post anything. It writes the finished issue to a
file and gives you the path, so you can file it wherever Pylon issues are
tracked.

To let triage search existing issues and file directly, point it at a
repository:

```bash
export PYLON_TRIAGE_REPOSITORY=https://github.com/your-org/pylon-issues
```

If you also have a repository the agent can read Pylon's source from, name it
separately. The agent clones it to match stack traces and log lines to real
code, which makes its diagnosis considerably better:

```bash
export PYLON_TRIAGE_SOURCE_REPOSITORY=https://github.com/your-org/pylon
```

Both are optional, and triage degrades gracefully without them: no source means
diagnosis from logs and state alone, and no issue repository means the report
lands in a file instead of a tracker.

## A turn stays on Starting

Pylon waits up to 60 seconds for a provider to confirm that a new turn started. If the provider does
not confirm it, the thread changes to an error state instead of staying on **Starting** forever. You
can retry the message after checking that the selected provider is signed in and available.

If a late provider response arrives after that timeout, Pylon ignores it. The late response cannot
revive the failed turn. If retries keep timing out, run the triage command above and include the
provider name and the time of the failed attempt.
