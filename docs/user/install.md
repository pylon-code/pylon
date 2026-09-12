# Install Pylon

Pylon runs coding agents on your computer and lets you control them from its desktop, web, or mobile
app. Set up the machine where the agents will work first.

## Requirements

Command-line use, SSH hosts, and WSL backends need Node.js 22.16+ (22.x), 23.11+ (23.x), or 24.10
and later. The native desktop app includes its server runtime. On a Mac, the desktop app needs macOS
13 Ventura or later; an app already installed on macOS 12 keeps its current version but no longer
receives updates.

You need an installed, authenticated provider before starting a thread. You can launch Pylon and
configure providers afterwards.

## Run without installing

```bash
npx t3@latest
```

This starts the server and opens the local web app. Run `npx t3@latest --help` for command-line
options.

If the web or desktop app shows "Pylon could not load", check your connection and select
**Reload** to try again.

## Desktop app

Download Pylon from the [download page](https://pylon-code.com/download), choosing **Stable** or
**Nightly**. Stable and Nightly are separate apps with their own projects, threads, and settings;
see [Updating Pylon](./updating.md#choose-a-desktop-track). Builds are not yet signed or notarized,
so macOS and Windows warn on first launch.

Pylon installs beside T3 Code rather than replacing it. The apps use different bundle IDs, URL
handlers, and data: Pylon keeps its runtime data under `~/.pylon-code`, while T3 Code keeps its own
`.t3` data.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects there. Install Node.js
and provider CLIs inside that distro. Pylon installs its matching server runtime into
`~/.pylon-code/wsl-runtime` there automatically; the first launch after an app update can take
longer.

The WSL backend keeps its projects and history in `~/.pylon-code/userdata` inside the distro,
separate from the Windows app's state. If you used a WSL backend before Pylon moved its state, your
projects and history are still in `~/.t3/userdata`. Pylon neither moves nor opens them, so the
backend starts empty and tells you where the older state is. To carry that work forward, stop the
WSL backend and move the directory, which includes your settings and saved credentials:

```bash
wsl -d <distro> -- sh -c '
  [ -d "$HOME/.t3/userdata" ] || { echo "Nothing to move."; exit 0; }
  [ -e "$HOME/.pylon-code/userdata" ] && { echo "Pylon already has state here; leaving both alone."; exit 1; }
  mkdir -p "$HOME/.pylon-code" && mv "$HOME/.t3/userdata" "$HOME/.pylon-code/userdata"
'
```

The command refuses to run when `~/.pylon-code/userdata` already exists, so it never merges two sets
of projects. Start the backend afterwards. Anything left in `~/.t3` is yours to delete; to start
fresh instead, do nothing.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
npx t3 app
```

This opens a new thread for the current directory, adding the project if needed. Pass a path, such
as `npx t3 app ../my-project`, to open another directory. It requires the desktop app, so a
standalone server or an SSH session is not enough. If the command cannot reach the app, start or
update the desktop app and try again.

## Mobile app

Pylon Mobile connects to a server on another machine. It is not yet distributed through app stores.
Follow [remote access](./remote-access.md) to link it through Pylon Connect or a pairing URL.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment, and enable the
provider you want. Installation, login, and configuration belong to that environment's machine,
even when you connect from a phone or another computer.

| Provider    | Install and authenticate                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.                     |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                  |
| Antigravity | Install and sign in with Google from Pylon's provider settings.                                           |
| Prime Agent | Install Prime Agent, then sign in with `/login`. See the [Prime Agent guide](./providers-prime-agent.md). |

Provider CLIs must be on the server's `PATH`. If Pylon cannot find one, set its **Binary path** in
provider settings, especially when using a version manager. Cursor's executable is `cursor-agent`,
although its login command is `agent login`. Antigravity can use its managed runtime without a
`PATH` entry.

When a provider CLI is behind its latest release, its provider card shows the available version.
**Update now** appears only when Pylon can tell which installer owns the CLI (its own update
command, Homebrew, or a global npm, pnpm, bun, or Vite+ install) and runs that installer. Otherwise
update the CLI the same way you installed it. Homebrew installs compare against the version
Homebrew offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each instance can have its
own environment variables, such as API keys or a custom base URL. Mark secret values as sensitive;
after saving, Pylon does not display their original values. Saving with a masked value keeps the
stored secret; enter a new value to replace it or clear the field to remove it.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), and [Prime Agent](./providers-prime-agent.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Pylon](./updating.md): update the app and connected servers.
