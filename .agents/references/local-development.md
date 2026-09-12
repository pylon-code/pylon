# Local development

Read when starting a dev environment, pairing a client, or preparing fixtures.

## Dev servers

- `vp i` installs. Worktrees get this from the compatibility-named `t3.json` setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- `vp run dev` needs a TTY. Launched from a plain non-interactive background shell it prints its first two lines and exits 0 without ever binding a port, which reads exactly like a fast successful start. Run it under `script -q /dev/null …` or `nohup … &` (there is no `setsid` on macOS), then confirm the port is actually listening before you trust it.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, then hand that full URL to the user with its pairing token intact. Do not wire up `tailscale serve` by hand for this, and do not open the complete pairing URL yourself.
- The web app requires pairing. For an explicit human handoff, provide the pairing URL rather than the bare origin — a URL without its token is useless to whoever you gave it to. Treat the token as a secret everywhere else: never commit it, capture it in screenshots, or reuse it. If a token got consumed, mint a fresh one with `node apps/server/src/bin.ts pair`; it carries standard scopes, while the startup URL carries admin scopes (needed for Settings → Connections management).
- Stop what you started, by the PID you tracked. See the process-ownership boundary in `AGENTS.md`.

## Test data

Use populated fixtures when the affected flow needs them. For an authorized snapshot of existing Pylon data, copy into isolated worktree state:

- Copy from **`~/.pylon-code/userdata`** — Pylon's own runtime home, and the only realistic fixture that matches this repo's schema. Worktree state still lives at `<worktree>/.t3/userdata`, which is a compatibility-named path, not a second source of data.
- **Do not seed from `~/.t3/userdata`.** Despite the compatibility-named path, that is T3 Code's database, and it carries upstream's migration numbering. Pylon renumbered 037–040 (`ProjectionThreadsPinned`, `ProjectionThreadsContinuedFrom`, `ProjectionTurnsKeysetIndex`, `ProjectionThreadsPinOrderKey`) and retired id 36, so a Pylon server started against a copy of T3's database records those ids as already applied and then dies on the first query with `no such column: continued_from_thread_id`. Reading it is still fine; seeding from it is not.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .t3/userdata
  # Use a fresh destination; VACUUM INTO refuses to overwrite an existing file.
  bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.pylon-code/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.
