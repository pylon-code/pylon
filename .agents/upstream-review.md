---
remote: t3code-upstream
branch: main
reviewed-through: "2a04db134c2d88f06e5b8d61a8410cb51ea07430"
reviewed-through-date: "2026-08-05"
---

# T3 upstream review log

This ledger is the durable handoff between upstream-review sessions. The `reviewed-through` commit is the newest upstream commit for which every candidate has received a user decision. Do not advance it for a partial review.

Deferred decisions remain listed after the cursor advances so later sessions can revisit them without rediscovering the entire upstream range.

## Review batches

## 2026-08-03 — `69dfb7f09a473d270a8b127cb1c39836fa1c6bc4..30c96228067bcd3a49e432ec898e52d4acb04297`

| Change set | Upstream              | Decision | Pylon reference                                       | Rationale or revisit condition                                           |
| ---------- | --------------------- | -------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| U1         | `30c962280` / `#5252` | adopted  | `upstream/2026-08-03-interface-spacing` / `3d976c4dd` | Low-risk web spacing polish with no overlap against Pylon modifications. |

## 2026-08-04 — `30c96228067bcd3a49e432ec898e52d4acb04297..c30a6d9b9943cfbf2fd47efc9de6eb9675457d52`

All thirteen candidates adopted onto `upstream/2026-08-04-batch`.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                 |
| ---------- | --------------------- | -------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1         | `6f04a5cff` / `#2916` | adopted  | `1f145579c`     | Linux secret storage for keyring-less compositors. Ported Pylon-first: `~/.pylon-code` runtime home, `pylon-code` WM class, Pylon keyring copy.                                                                                                |
| A2         | `a261a6440` / `#5303` | adopted  | `73efb12b4`     | Loading screen painted `#161616` while Pylon's dark `--background` is `neutral-950`; upstream value matches Pylon.                                                                                                                             |
| A3         | `11639bf43` / `#5314` | adopted  | `f67e2e224`     | Restores terminal cursor blink and gates it on `prefers-reduced-motion`.                                                                                                                                                                       |
| A4         | `553867262` / `#5322` | adopted  | `d212d7c8b`     | Held Ctrl/Cmd+W no longer escapes to the native window accelerator after the terminal closes.                                                                                                                                                  |
| A5         | `1cbd88aba` / `#5319` | adopted  | `322cb207c`     | Replayed terminal history no longer re-triggers DECRQM/XTVERSION/DECRQSS replies as prompt junk.                                                                                                                                               |
| A6         | `966cc05a9` / `#5327` | adopted  | `70c36e8de`     | Forward-compatible provider decode; matters more for Pylon given multi-client version skew over remote connections.                                                                                                                            |
| A7         | `25ec0b9d1` / `#5301` | adopted  | `5dcfffe7d`     | Chat code-block restyle. Revisit if it conflicts with Pylon's dot-matrix design language.                                                                                                                                                      |
| A8         | `cec1bb9de` / `#5304` | adopted  | `a04939489`     | Multiline error alerts align controls to the first line.                                                                                                                                                                                       |
| A9         | `2b1d4fecb` / `#5331` | adopted  | `8ca9e45e1`     | Effect beta.103. Swaps Pylon's hand-rolled gzip middleware for `HttpMiddleware.compression()` and enables websocket permessage-deflate. Lockfile regenerated against Pylon, not taken from upstream. Watch for uWebSockets close-1006 reports. |
| A10        | `8a16cadba` / `#5326` | adopted  | `000967d8f`     | Tooltips now render above popovers and menus.                                                                                                                                                                                                  |
| A11        | `82b76e213` / `#5073` | adopted  | `d40f8b34b`     | Cursor todos with blank content fall back to the title instead of dropping the step.                                                                                                                                                           |
| A12        | `37ae1abbe` / `#4347` | adopted  | `1015cb409`     | Managed SSH tunnels no longer share the user's ControlMaster socket.                                                                                                                                                                           |
| A13        | `c30a6d9b9` / `#5075` | adopted  | `d500e0d6f`     | AppImage terminals stop inheriting the bundle's `XDG_DATA_DIRS`/`GSETTINGS_SCHEMA_DIR`. Pylon ships AppImage.                                                                                                                                  |

## 2026-08-04 — `c30a6d9b9943cfbf2fd47efc9de6eb9675457d52..d7950ac153c6fdd788ef63699a5d061243bb4997`

All four candidates adopted onto `upstream/2026-08-04-followup`.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                    |
| ---------- | --------------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| B1         | `94331c58e` / `#4586` | adopted  | `2ad93b4d5`     | Mobile now renders distinct Grok, Cursor, and OpenCode provider marks instead of falling back to Codex.                           |
| B2         | `90e377866` / `#5353` | adopted  | `ec1fafcbd`     | The floating provider-status banner uses Pylon's existing alert glass surface so chat content no longer reads through it.         |
| B3         | `36caf34c6` / `#5148` | adopted  | `5ff760764`     | Live context-window history is bounded, sidebar prewarming is reduced, and desktop renderer crashes recover with bounded reloads. |
| B4         | `d7950ac15` / `#5357` | adopted  | `1a8b25a59`     | Thread titles focus on durable intent; upstream's T3 Code prompt copy was adapted to Pylon.                                       |

## 2026-08-05 — `d7950ac153c6fdd788ef63699a5d061243bb4997..2a04db134c2d88f06e5b8d61a8410cb51ea07430`

All sixteen candidates adopted. Fifteen landed on `upstream/2026-08-05-batch` and merged into `pylon`
as `c18398bf9`.

C9 was held back for one round and then merged into `pylon` as `72da243e6`, since remote
background-service updates are planned work. Note for whoever sets that up: launcher protocol 2 fails
closed, so an install running protocol 1 needs one **local** service update before remote updates
containing migrations will apply.

The browser verification pass found that C14's fix did not resolve the bug it targets — the composer
command menu still detached by ~270px on panel toggle and only re-anchored on a window `resize`. Worked
around Pylon-side in `ce5371d41` by re-measuring the position across animation frames until it settles.

**The root cause is not established.** The commit message for `ce5371d41` claims the composer keeps moving
after its ancestors resize; later instrumentation disproved that — the `ResizeObserver` fires once and the
anchor's rect is already correct at notification time, and no ancestor has a non-zero transition duration
for a geometric property. So the single update is computed correctly and then lost somewhere between
`setPosition` and the portal. The fix is a real fix for the symptom, not an explanation. Treat that commit
message as wrong on the "why" and revisit if the menu misbehaves again.

`ChatComposer.tsx` is now a deliberate Pylon-only divergence; the defect remains upstream and is worth
reporting there.

| Change set | Upstream                                  | Decision | Pylon reference          | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ----------------------------------------- | -------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1         | `9bd2a4c68`+`2fa1fec8d` / `#5365`,`#5368` | adopted  | `a526ad17a`, `3dac04559` | Regeneration pins the first user message when context truncates, so titles keep the durable subject. Follows B4. Upstream's plaintext prompt templates were re-branded to "Pylon thread".                                                                                                                                                                                                                                                                                                                                                                                    |
| C2         | `4fb03aff0` / `#5260`                     | adopted  | `d720997d9`              | Right-panel and diff restyle, removes a virtualizer padding shift, and adds a `getReviewDiffFileContents` RPC for full-file expansion. Revisit if the flattened diff chrome fights Pylon's dot-matrix design language.                                                                                                                                                                                                                                                                                                                                                       |
| C3         | `8eca20005`+`2a04db134` / `#5103`,`#5397` | adopted  | `294162a47`, `4596235d0` | Configurable interface/prompt/code/terminal fonts. Feature adopted wholesale; **upstream's default-typography change was rejected** and Pylon's bundled DM Sans and JetBrains Mono restored as the defaults in `b9c97d2f7`. Upstream dropped the brand faces as an unargued side effect: issue `#4376` asked for the shipping default to stay, and `#3014` had deliberately bundled them to leave Google Fonts. Restoring them also required re-probing the default family labels after font loading settles, since that probe assumed synchronously available system faces. |
| C4         | `41ebf22ee` / `#5384`                     | adopted  | `fa72a7d59`              | Clears lint warnings in the web components C3 touched plus the command palette and update pill.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C5         | `da6e1a967`+`e0c85a20e` / `#5312`,`#5391` | adopted  | `5a1e0527e`, `84a548ca9` | Sidebar v2 thread pinning, server-backed with pin and unpin both present, plus the mobile double-divider fix. **Upstream's migration 036 was renumbered to 037**: Pylon retired id 36 with the unreleased Kanban board, and reusing it would let those environments silently skip the `pinned_at` column. Value is beta-gated while `sidebarV2Enabled` defaults false.                                                                                                                                                                                                       |
| C6         | `fff6a5b02` / `#5360`                     | adopted  | `5d4503589`              | Scannable 168px pairing QR behind a Share button with a LAN/Tailscale/hosted endpoint picker; loopback is excluded as a QR target. Directly serves Pylon's remote-ready pillar. Pylon's `ConnectionStatusDot` dot-matrix call sites were preserved.                                                                                                                                                                                                                                                                                                                          |
| C7         | `94696b0f5` / `#4703`                     | adopted  | `20fe5b5a5`              | In-app browser: Enter attaches an annotation, Cmd/Ctrl+Enter sends, the full URL is shown, and Cmd/Ctrl+R reloads the preview instead of the app.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| C8         | `7537adc30`+`37d3667de` / `#5349`,`#5400` | adopted  | `f5b9dba6a`, `ede9dd18c` | Model picker reserves a stable scrollbar gutter and stops showing stale positional shortcut hints across menus.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C9         | `7b38fb5c6` / `#5374`                     | adopted  | `e36cd6e7f`              | Remote background-service updates may now ship SQLite migrations: the launcher snapshots and restores the database with its WAL and SHM around a trial. Launcher protocol 2 fails closed until one local service update lands, so existing installs need that step before remote migration updates work.                                                                                                                                                                                                                                                                     |
| C10        | `3d429662c` / `#5128`                     | adopted  | `6def786d9`              | OpenCode with Kimi models rejected the preview MCP tools because the shared URL validator emitted two `allOf` descriptions.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| C11        | `47dfc6526` / `#4642`                     | adopted  | `947e05071`              | Grouped projects no longer discard sibling physical workspaces; the grouping core moves into `client-runtime` and mobile gains the grouping settings. Also changes web sidebar grouping, which may warrant a `docs/user/` note.                                                                                                                                                                                                                                                                                                                                              |
| C12        | `70de6e178` / `#5386`                     | adopted  | `21d615265`              | Android thread search crashed at two characters because Hermes lacks `Array.prototype.toSorted()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| C13        | `3c5bdb84a` / `#5348`                     | adopted  | `91b9bef3a`              | Long project names truncate in the new-thread headline and switcher instead of forcing a horizontal scrollbar.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| C14        | `9235c83eb` / `#5336`                     | adopted  | `294587cb6`              | The composer command menu tracks the composer when a side panel or terminal drawer slides it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| C15        | `9d9a872bc` / `#5382`                     | adopted  | `730caefc6`              | Terminal link hover underline and pointer feedback, lost in the Ghostty canvas migration, are restored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C16        | `9697b765e` / `#5394`                     | adopted  | `a28fef062`              | Release publishing uses the job-scoped `GITHUB_TOKEN` instead of the Release App quota. Taken for drift reduction; Pylon's `release.yml` is still upstream's and the shared-quota problem it solves is T3's, not Pylon's.                                                                                                                                                                                                                                                                                                                                                    |

For each completed batch, append a section in this form:

```markdown
## YYYY-MM-DD — `<previous-cursor>..<reviewed-head>`

| Change set | Upstream      | Decision                      | Pylon reference        | Rationale or revisit condition |
| ---------- | ------------- | ----------------------------- | ---------------------- | ------------------------------ |
| A1         | `sha` / `#pr` | adopted, skipped, or deferred | branch, commit, or `—` | concise reason                 |
```

## 2026-08-06 — Pylon-local fixes on top of `#5219`

First Pylon changes in two files that were byte-identical to upstream
`a2ca89aa1`. Expect conflicts in both on the next upstream sync, and check
whether upstream has landed its own fix in a different shape before
resolving.

| File                                                   | Change                                                                                                                                                                                | Upstream status                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/client-runtime/src/state/subagentRuntime.ts` | `task.started` gains a third branch: a terminal agent reopens when the payload's `toolUseId` differs from the one that opened the current run. Fold-local `activationToolUseIds` map. | Reported on [#5529](https://github.com/pingdotgg/t3code/issues/5529) with the wire evidence; open, unfixed. |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`     | `task_started` preserves an already-refined `model` when re-seeding `taskAgents` for the same `task_id`, mirroring the existing `runHandles` carry-across.                            | Not yet filed.                                                                                              |

Known remaining gap, not fixed: a subagent that settles before emitting any
assistant snapshot never refines its model, so a short first run keeps the
session-model placeholder. That is a UX decision on upstream's
placeholder-then-refine strategy, not a defect in it.
