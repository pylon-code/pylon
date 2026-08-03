# Pylon

Pylon is an open source GUI for coding agents, forked from T3 Code. A Node WebSocket server wraps provider CLIs (Codex, Claude Code, Cursor, Grok, OpenCode) and serves web, desktop, and mobile clients.

You can think of Pylon as a "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass, and Conductor.

## Compatibility names

Pylon still retains upstream compatibility identifiers such as `.t3`, `T3CODE_HOME`, `t3.json`, `npx t3`, `@t3tools/*`, `com.t3tools.*`, and some T3-named source files. Treat those as implementation details, not product copy. Do not rename compatibility identifiers during branding or UI work unless the developer explicitly expands the scope and the migration is handled across every client and connection mode.

## Fork direction and source control

Pylon is a long-lived independent product, not a temporary reskin or a patch queue intended to collapse back into T3 Code. Build in Pylon's direction while preserving the upstream qualities described below.

- The canonical repository is the private `rynfar/pylon` repository. Its writable remote is `origin`, and its default product branch is `pylon`.
- Base Pylon work on `pylon` or a task branch created from it. Do not treat the inherited `main` branch as Pylon's product branch.
- `t3code-upstream` (`pingdotgg/t3code`) and `t3code-fork` (`rynfar/t3code`) are reference remotes. They are intentionally fetch-only. Never push to them or re-enable their push URLs.
- Upstream changes are opt-in. Fetch and inspect upstream commits, then cherry-pick or selectively merge only changes that benefit Pylon. Do not hard-reset, wholesale rebase, or replace Pylon with an upstream branch.
- Resolve upstream conflicts Pylon-first. Preserve Pylon branding, agent guidance, Kanban behavior, and later Pylon-specific product decisions unless the developer explicitly chooses otherwise.
- An inherited compatibility name is not permission to restore visible T3 branding. Keep product identity and runtime compatibility separate.
- Before committing or publishing, verify the current branch and remotes. If the checkout is not rooted in the Pylon repository or a push would target a T3 remote, stop and correct it before proceeding.

## What makes Pylon special?

Pylon inherits a product used by more than 100,000 people. Preserve the qualities that made the upstream project successful while giving the fork a coherent Pylon identity.

### 1. Open at the core

Pylon stays open at the core. Share the roadmap, the reasoning, and the code. The upstream project's strong fork culture is part of what made Pylon possible.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". Pylon inherits a fast foundation and must keep it fast. Regularly consider websocket payload size, CSS animations that cause GPU spikes, and expensive list rendering.

### 3. Remote ready

The inherited websocket layer (`npx t3`) enables core remote features. Whether users connect over their local network, Tailscale, or the bundled tunnel solution, new features need a deliberate remote-support decision.

### 4. Multi-surface

Pylon has three key app surfaces: **web**, **desktop**, and **mobile**.

**Web** has hosted and local modes. The inherited hosted origin is `app.t3.codes`, while `npx t3` hosts the web app locally. Both modes need support where reasonable until Pylon infrastructure deliberately changes them.

**Desktop** is the main surface most users install first. It is an Electron app that bundles the server runner and can host remote connections from the hosted web client or mobile app.

**Mobile** is a React Native app for iOS and Android. It connects to a compatible Pylon environment to control work remotely.

## Inherited product principles

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Most Pylon contributions may come from Pylon itself, often controlled remotely. Be careful when accessing data, stopping dev servers, or taking actions that could damage the environment the contributor is actively using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing Pylon.
- **we, us, and maintainers** mean the people maintaining Pylon. Use **upstream maintainers** when specifically referring to T3 Code's maintainers.
- **user** means the person using Pylon to direct coding agents.
- **agent** means the coding agent a user runs inside Pylon. Depending on context, that may also include you.
- **provider** means the agent runtime or harness Pylon talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running Pylon server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **runtime home** means the base data directory. It currently uses T3-compatible paths and environment variables; runtime state normally lives below its `userdata` directory.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real Pylon/T3-compatible database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, and OpenCode each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** `docs/` splits by audience. Behavior changes that a user would notice belong in `docs/user/` (shipped-product voice, no repo tooling or source paths); architecture and contributor changes in `docs/internals/`; runbooks in `docs/operations/`; new vocabulary in `docs/internals/glossary.md`.

## Dev servers

- `vp i` installs. Worktrees get this from the compatibility-named `t3.json` setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- `--share` publishes over the tailnet. Do not open the complete pairing URL yourself; hand it to the user with its pairing token intact.
- The web app requires pairing. For an explicit human handoff, provide the pairing URL rather than the bare origin. Treat its token as a secret everywhere else: never commit it, capture it in screenshots, or reuse it.
- Stop what you started, by the PID you tracked. See rule 1.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- Copy from `~/.t3/userdata` (the developer's real data, the most realistic test set) or `~/.t3/dev`. Worktree state lives at `<worktree>/.t3/userdata`.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .t3/userdata
  rm -f .t3/userdata/state.sqlite*  # VACUUM INTO refuses to overwrite
  bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- Upon request, user-visible frontend changes should get one integrated pass in a real client: `test-pylon-app` for web, `test-pylon-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Ask permission before doing computer use or spinning up browsers.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- **Rebase onto the latest `pylon` branch before opening.** Stale branches conflict and burn a review round. Never rebase a Pylon branch directly onto a T3 remote.
- UI changes need before/after images. Motion or timing needs a short video.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
