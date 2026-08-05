# Handoff — build `feat/2026-08-04-account-drain-routing` for a two-account drain test

You are building a runnable Pylon for the developer to test multi-account Claude usage and
drain-and-swap routing by hand. Nothing on this branch has been seen in a running client, so
your build is the first look.

## Read this before promising the developer anything

**Draining a running thread does not move it.** Phase B routes *new* threads away from a spent
account. An existing thread stays bound to the account it started on, by design — mid-thread
handoff is Phase C and is not built. If the developer drains their work account mid-thread and
expects that thread to continue on the personal account, that will not happen and it is not a
bug. What they can verify is: the spent account is detected, the sidebar pill appears, and the
*next new thread* opens on the personal account.

Say this up front rather than after the test fails.

## Branch

```
branch:   feat/2026-08-04-account-drain-routing
repo:     rynfar/pylon  (remote `origin`; never push to t3code-* remotes)
contains: pylon fully merged (verify with `git merge-base --is-ancestor pylon HEAD`)
worktree: .claude/worktrees/provider-usage-limits  (already checked out there)
```

Both phases are on this one branch: Phase A (usage visibility) and Phase B (drain state,
routing, drain pill, settings reorder), plus the OAuth usage source that replaced the CLI
scrape.

## Prerequisite the build cannot substitute for

The developer needs **two real Claude logins**. The branch currently has a *fixture* second
account — `claude_personal` in the worktree's settings points at the default config dir with no
separate `CLAUDE_CONFIG_DIR`, so both accounts report the same usage. A real second account is
what makes the test meaningful:

```bash
mkdir -p ~/.claude_personal_home
CLAUDE_CONFIG_DIR=~/.claude_personal_home claude auth login
```

Use `CLAUDE_CONFIG_DIR`, not `HOME` — overriding `HOME` relocates the macOS keychain lookup and
the CLI reports "Not logged in". Then in Pylon's Settings → Providers, the second Claude
instance's **CLAUDE_CONFIG_DIR path** must be `~/.claude_personal_home`.

Confirm both accounts resolve to different emails before testing anything:

```bash
claude auth status --json | jq -r .email
CLAUDE_CONFIG_DIR=~/.claude_personal_home claude auth status --json | jq -r .email
```

## Build

Install first (`vp i`). Two options — pick with the developer, they are not equivalent:

**Dev shell** — fastest, hot-reloads, best if they expect to report issues and want fixes
without a rebuild:

```bash
vp run dev:desktop
```

**Packaged app** — a real installable build, right if they want to run it for hours as their
actual app while draining an account:

```bash
vp run dist:desktop:dmg      # arm64 on Apple Silicon; :x64 / --arch to force
```

Artifacts land in `./release`. Host here is arm64 (Apple Silicon).

`vp run build:desktop` builds the pipeline without packaging — useful to check the build is
sound before spending time on a DMG.

## Runtime home — decide before first launch

Per `CLAUDE.md` the packaged Pylon app uses `~/.pylon-code`, deliberately separate from
`~/.t3` so Pylon and T3 Code can coexist. **A packaged build will therefore not see projects
that live in `~/.t3`.** `T3CODE_HOME` overrides it (`apps/desktop/src/app/DesktopConfig.ts:39`).

Ask the developer which they want and confirm what actually happened on first launch rather
than assuming:

- *Their real projects* — point the build at the existing home explicitly.
- *A clean room* — let it use its own home and add a project by hand.

Do not copy data out of a running install; if seeding is wanted, snapshot with `VACUUM INTO`
(see `CLAUDE.md` → Test data) and copy in, never out.

## Verify before handing it over

Nothing below has been confirmed in a client. Check each and report what you actually saw:

1. **Claude usage appears at all.** Open the context-window popover on a Claude thread. A
   "Provider limits" section should list Session / Weekly (all models) / Weekly (<model>). This
   was blank for the whole of Phase A because of two CLI format breaks; it now reads a JSON
   endpoint instead, so a blank section means a real regression, not the old bug.
2. **The numbers are account-wide.** They should match claude.ai, not the lower figure
   `claude --print "/usage"` prints (that reported only this machine's share — 17% against 40%
   for the same account).
3. **Composer strip.** Below the composer: branch selector on the *left* beside the workspace
   control; usage on the right as `● 5h N% · 7d N%` with small fill bars. Bars and numbers turn
   amber past 80%. Check it does not crowd the branch selector at narrow widths — that is the
   most likely visual problem.
4. **Per-account usage.** With two real logins, each provider card in Settings → Providers
   should show its own account's numbers. Identical numbers means the keychain lookup fell back
   to the default config dir.
5. **Drain order.** Settings → Providers shows up/down arrows on Claude cards when two accounts
   exist. Reordering should persist and survive a restart.
6. **On drain:** a pill appears in the sidebar footer naming the account that took over and when
   the spent one resets. New threads should then open on the other account. Existing threads
   should not move — see the warning at the top.

## Known gaps — do not present these as working

- **Mobile is untouched.** Neither phase changed `apps/mobile`. The composer strip change is
  web/desktop only.
- **Phase C (thread handoff) does not exist.**
- **The OAuth usage endpoint answers 429 under load.** One 429 was observed in development. The
  cache is 5 minutes on success, 1 minute on failure. With several accounts polling this is
  unproven; if usage goes blank intermittently, suspect the rate limit first.
- **Usage reads credentials, never writes them.** An expired access token yields no gauge until
  something else refreshes it (running the Claude CLI does). There is no CLI fallback — that was
  removed deliberately because its numbers describe something different.

## If you change anything

Focused tests plus targeted lint and typecheck only — no repo-wide checks. The server package is
named `t3`, not `@t3tools/server`; a `-F @t3tools/server` filter exits 0 having checked nothing.
Do not open a PR unless the developer asks.
