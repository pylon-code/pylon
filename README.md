# Pylon

Pylon is an "agent harness control surface". It enables control of the agents on your machine from a desktop app, a web app, and a mobile app.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, Pylon can control them.

Pylon is a fork of [T3 Code](https://github.com/pingdotgg/t3code), developed as an independent product. It keeps a number of `t3`-named compatibility identifiers — the `t3` CLI, `t3.json`, `~/.t3` — because renaming them would break existing setups. Those are implementation details, not the product.

## "Wait, what are you selling me?"

Nothing. Pylon exists because we wanted the best possible development experience with agents. The upstream project was inspired by the Codex desktop app, Conductor, Claude Desktop, and Cursor Glass, and none of them met the bar.

We wanted something performant, remote-ready, and truly open. If Pylon ever goes the wrong direction, you should have everything you need to fork it and build the tool you want — the same way Pylon exists at all.

## Installation

> [!WARNING]
> Pylon supports Codex, Claude, Cursor, Grok Build, and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Desktop app

Download the latest build from [Releases](https://github.com/pylon-code/pylon-releases/releases):

| Platform              | File                |
| --------------------- | ------------------- |
| macOS (Apple Silicon) | `Pylon-*-arm64.dmg` |
| macOS (Intel)         | `Pylon-*-x64.dmg`   |
| Linux                 | `Pylon-*.AppImage`  |
| Windows               | `Pylon-*.exe`       |

Stable builds are marked as the latest release. Nightly builds are published as
prereleases; the app can follow either channel and updates itself in place.

> [!NOTE]
> Builds are not yet signed or notarized, so macOS and Windows will warn on first
> launch. Pylon is also not published to winget, Homebrew, or the AUR, and has no
> npm package of its own — `npx t3` installs upstream T3 Code, not Pylon.

### Run from source

Requires Node.js 22.16+, 23.11+, or 24.10+, and the `vp` CLI (see below):

```bash
vp i
vp run dev
```

This launches Pylon's backend on your machine along with the local web app.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run Pylon as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

Pylon uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.
