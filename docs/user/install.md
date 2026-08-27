# Install Pylon

Pylon is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the Pylon server.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Run Without Installing

```bash
npx t3@latest
```

This starts the Pylon server on your machine and opens the local web app. Use
`npx t3@latest --help` for the full CLI reference.

## Desktop App

### Pylon fork

Pylon's desktop build installs beside T3 Code rather than replacing it. The apps use different
bundle IDs, URL handlers, Electron profiles, runtime databases, and updater metadata. On macOS the
local Pylon build installs as `Pylon (Alpha).app`; its default runtime data lives under
`~/.pylon-code`, while T3 Code continues using its own `.t3` and Electron data.

From the Pylon repository, build the local macOS installer with:

```bash
PYLON_DESKTOP_LOCAL_SIGNING_IDENTITY="Apple Development: Your Name (TEAMID)" \
  vp run dist:desktop:dmg
```

Use an identity listed by `security find-identity -v -p codesigning`. You can omit the environment
variable for an ad-hoc-signed build, though newer macOS provenance policy may reject that build
after it is copied from the DMG.

Open the generated `Pylon-*.dmg` in `release/`, copy `Pylon (Alpha).app` into Applications, and use
the normal macOS right-click **Open** flow if the first unnotarized local launch is blocked.

### Upstream Pylon

Download the latest release from
[GitHub Releases](https://github.com/pingdotgg/t3code/releases), or install from a package
registry.

Windows:

```bash
winget install T3Tools.T3Code
```

macOS:

```bash
brew install --cask t3-code
```

Arch Linux:

```bash
yay -S t3code-bin
```

## Providers

Pylon drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                   | Default binary | Log in with           |
| ---------- | ----------------------------------------------------- | -------------- | --------------------- |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)  | `codex`        | `codex login`         |
| Claude     | [Claude Code](https://claude.com/product/claude-code) | `claude`       | `claude auth login`   |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                  | `cursor-agent` | `agent login`         |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                    | `grok`         | `grok login`          |
| OpenCode   | [OpenCode](https://opencode.ai)                       | `opencode`     | `opencode auth login` |

Codex and Claude are on by default. Cursor, Grok Build, and OpenCode are off by default; turn
them on in **Settings** → the provider's card when you want to use them.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
Pylon looks for, but authenticate with `agent login`, not `cursor-agent login`.

Grok models that support adjustable reasoning show a **Reasoning** control beside the model picker.
The available levels and default come from the installed Grok Build CLI, so they can vary by model
and CLI version.

Run the login command on the machine running the Pylon server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started Pylon.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
Pylon. You can install Pylon, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much Pylon asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping Pylon in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
