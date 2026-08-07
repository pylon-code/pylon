---
remote: t3code-upstream
branch: main
reviewed-through: "a8cd2ad2ebb32ad789e8e0ecd2fc713c2edc38f4"
reviewed-through-date: "2026-08-07"
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

## 2026-08-04 — unmerged upstream pull request (did not move the cursor)

Out-of-band review of a single open pull request, adopted ahead of merge at the developer's
request. This session did not advance `reviewed-through`: `#4326` is not in
`t3code-upstream/main`, and one pull request is not a commit range. The cursor's current value
comes from the separate range review below, which ran independently.

| Change set | Upstream             | Decision                  | Pylon reference                                                        | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | -------------------- | ------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-4326     | `0abc172d` / `#4326` | adopted (with adaptation) | `upstream/2026-08-04-provider-usage-limits` / `5c28cfc38`, `bf0c025d2` | Subscription usage windows on provider snapshots. Applied as a manual port of the pull request's net diff — the branch sits 84 commits behind upstream main, so its series does not cherry-pick. Pylon adaptations: multi-account popover, and `showProviderUsageInContextPopover` defaulted on. **Revisit when `#4326` merges** — reconcile Pylon's variant against the merged form, which may differ after review. |

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

For each completed batch, append a section in this form:

```markdown
## YYYY-MM-DD — `<previous-cursor>..<reviewed-head>`

| Change set | Upstream      | Decision                      | Pylon reference        | Rationale or revisit condition |
| ---------- | ------------- | ----------------------------- | ---------------------- | ------------------------------ |
| A1         | `sha` / `#pr` | adopted, skipped, or deferred | branch, commit, or `—` | concise reason                 |
```

## 2026-08-06 — `2a04db134c2d88f06e5b8d61a8410cb51ea07430..a2ca89aa10f13a2222e08afd98c66285121d5ba2`

All five candidates adopted. D1–D4 landed on `upstream/2026-08-06-terminal-and-reconnect`; D5 was
integrated separately on `upstream/2026-08-06-subagent-observability` because its reconciliation with
Pylon's dot-matrix status language is a design decision rather than a merge.

D5 is the largest upstream change adopted so far. It ships with gaps upstream acknowledges: Claude and
Codex only, with no path for Cursor, Grok, or OpenCode; mobile receives the quiet timeline fold but no
Agents surface; the `getWorkflowScript` RPC does not yet verify its path against the requesting
thread's own run handles. It also bumps `RIGHT_PANEL_STORAGE_VERSION` from 7 to 8, which resets every
user's persisted right-panel layout once. **Not yet verified in a real client** — the Agents panel,
spawn CTA rows, and the Monitoring status have had no browser pass.

Verification note for this batch: `ProviderRuntimeIngestion.test.ts` cannot run in this environment.
Its 45 sqlite-backed tests fail with `UnsupportedNodeSqliteVersionError` on Node 22.15.1 while the repo
requires `^24.13.1`, and they fail identically on `pylon` without any of these commits. Pre-existing
toolchain breakage, not adoption fallout, but it means that file's coverage of D5 is unproven locally.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                           |
| ---------- | --------------------- | -------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1         | `de592a00e` / `#5428` | adopted  | `26006f524`     | Terminal font previews exercise bold, dim, underline, the six accent colors, and a background cell. The sample prompt's project segment was rebranded from `t3code` to `pylon` on both web and mobile. `scripts/mobile-showcase-environment.ts` keeps its T3-named fixture; that is pre-existing branding debt, tracked separately.      |
| D2         | `30e471530` / `#5444` | adopted  | `c6a51a199`     | Splitting a terminal halved the configured font size. Removes `fittedTerminalFontSize`, which Pylon had picked up with C3 in `294162a47`; pane width now changes the grid, not the glyphs.                                                                                                                                               |
| D3         | `7251f1a1f` / `#5432` | adopted  | `e248af7df`     | The opaque canvas backing store flashed black for the whole font and WASM setup window; it is now painted with the theme background up front.                                                                                                                                                                                            |
| D4         | `990bb0b68` / `#5404` | adopted  | `62b5474db`     | A ~15s update restart read as a ~33s "Resuming" because reconnect nudged once and then climbed the backoff ladder. Serves the remote-ready pillar and pairs with C9 (`72da243e6`).                                                                                                                                                       |
| D5         | `a2ca89aa1` / `#5219` | adopted  | `dc4dc1f6e`     | Native subagent and workflow observability. Status reads through Pylon's DotMatrix language rather than upstream's plain dots, and the new Monitoring state is the calm sibling of Working — same primary hue, steady `live` glyph instead of the spinner. Revisit the Monitoring treatment if the dot-matrix language grows a real one. |

## 2026-08-07 — `a2ca89aa10f13a2222e08afd98c66285121d5ba2..a8cd2ad2ebb32ad789e8e0ecd2fc713c2edc38f4`

Thirty-five upstream commits, twenty-one change sets. Twenty adopted onto
`upstream/2026-08-07-batch`; only E21 skipped. Upstream is mid-stabilization —
24 of the 35 commits are `fix` — so most of this batch is inherited-defect
repair rather than new product surface.

Two Pylon-only follow-up commits close the batch: `ee2d74665` regenerates the
lockfile and rebrands the transfer-budget report, and `89f71f4d3` repairs a
fork-only test that E15 broke.

**E15 is a product-direction change, not a fix.** Plans stop being a
right-panel surface and fold inline into the transcript: `PlanSidebar.tsx` is
gone, the `autoOpenPlanSidebar` setting is removed with no replacement, and
`RIGHT_PANEL_STORAGE_VERSION` goes 8 → 9. That is the **second persisted
right-panel layout reset in two batches** — D5 already took users 7 → 8, so
anyone who reshaped their panel after D5 loses it again. Adopted on the
developer's explicit call ("I think I like the direction, if I hate it we can
always adjust after"), then **confirmed in a browser pass** — the developer
reviewed the inline chip against real seeded threads and preferred it to the
sidebar. The open question is no longer the design; it is only whether the
one-time layout reset bothers anyone.

**Partly verified in a real client.** Two web passes ran against a copy of the
real database (3 projects, 9 threads, 68 turns, 6,254 activities, 39k events).
Migration 039 applied over an existing 37/38 database, and four change sets
were confirmed against real data rather than only by test:

- **E1** — thread `3fbd40f6` holds 238 `tool.updated` rows; the snapshot ships
  **54**. 184 superseded rows (77%) dropped, all 119 `tool.completed` retained.
- **E10** — the full snapshot of thread `4ca33c5c` is 1,491,779 bytes with no
  `page`; `?turnLimit=10` returns 656,559 bytes (**56% smaller**) with
  `hasMore: true` and a cursor decoding to `{thread, requested_at, turn_id}`.
  In the UI the "Load earlier turns" header appears, pages on click, and
  correctly disappears once 10 + 20 covers the thread's 26 user turns.
- **E15** — an expanded plan chip renders five DotMatrix step markers
  (`data-state="done"`) and **zero** of upstream's `✓ ● ○` glyphs, confirming
  the Pylon-first marker conversion. Developer reviewed and preferred it.
- **E14** — a live Haiku 4.5 run in a throwaway `/tmp` project spawned three
  real subagents, which the seeded database could not supply. The Agents panel
  rendered three rows at exactly **62px** (`3.875rem`, the fixed-height
  guarantee) with the marker's right edge at 769px against a title starting at
  777px — an 8px gutter, no bleed. This confirms the Pylon-first track
  widening; upstream's `0.375rem` would have consumed the whole `gap-x-2`
  gutter. It is also the first real exercise of D5's Agents panel.

Still unproven, with the reason: **E3's in-flight status** needs a real update,
and `start:mock-update-server` cannot supply one without a prebuilt
`release-mock` release tree. **E13's scroll anchoring** was never cleanly
isolated — see the defect note below, which sits in the same code path. **No
mobile pass ran**, so E19's card opacity, E13's `ThreadFeed` anchoring, and
E10's mobile wiring are untested on that surface. Desktop was never launched.

### Open defect found during verification — pre-existing, not from this batch

While streaming, the newest transcript content and the working row render
**underneath the chat composer**. Measured mid-stream with a healthy
connection and no reconnect banner: the composer overlay starts at y=604 and
the working indicator sat at y=669, 65px behind it, with the last text row
sliced at the composer's edge.

Cause: the composer inset is consulted for _whether_ the view is at the end
(`resolveTimelineIsAtEnd(state, endInset)`) but not for _where_ the list stops.
`maintainScrollAtEnd` pins to the raw scroll-viewport end, driving past the
clearance the end spacer provides. With follow inactive the spacer yields a
correct 144px gap, which is why it only shows while streaming.

**Not caused by this batch.** `contentInsetEndAdjustment` and the
`maintainScrollAtEnd` configuration are byte-identical on `origin/pylon`;
E13's only change was adding `|| !liveFollowEnabled`, which _disables_ pinning
in more cases and cannot make it overshoot. Confirming beyond that inference
needs an `origin/pylon` A/B, which was not run. Fix belongs on its own branch
off `pylon` — likely growing the end spacer during live follow — and is worth
reporting upstream.

Verification that did run: 495 targeted tests pass (187 web, 181 server, 112
client-runtime, 15 shared) plus the 6 Node tests for the new CI publisher;
lint clean over all 105 changed TypeScript files; typecheck clean across `t3`,
web, mobile, client-runtime, contracts, and shared. Note that `vp test run`
from the repository root resolves a **global** vitest and reports
`Tests no tests` with every file failing while still exiting 0 — it also
substring-matches test paths into sibling worktrees under `.claude/worktrees`.
Run `node_modules/.bin/vitest run` from the package directory instead.

| Change set | Upstream                                                                | Decision | Pylon reference                                                              | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1         | `3da315e7b`+`b7d1981b5`+`e4abc31f1` / `#5482`                           | adopted  | `2a6867f83`, `63bce307b`, `892033d46`                                        | Thread snapshots stop shipping full MCP tool results and superseded `tool.updated` rows — 47k such rows in one real database, 3,291 in a single thread. Straight at the performance pillar; `ActivityPayloadProjection.ts` had no Pylon divergence. The third commit pins the interleaved-collapse tradeoff (1.5% of dropped rows) with a test.                                                                                                                                                                                      |
| E2         | `808d68535`,`8f341f20c`,`f9e823689`,`df2f1273e`,`8b2ea5721`,`64a3cd6d7` | adopted  | `ea530e1cb`, `67dadf1d4`, `775ee911d`, `243a0eb95`, `5f231daac`, `e7c27ebd3` | The managed tunnel survives update restarts: releasing it forced the replacement hostname through 1–2 minutes of edge propagation, so a server back in ~9s stayed unreachable ~96s. A launcher stop marker keeps `service stop`/`systemctl stop` releasing it properly. Extends C9 (`72da243e6`); serves the remote-ready pillar.                                                                                                                                                                                                    |
| E3         | `80720ad59`+`48e2c27f2`                                                 | adopted  | `fdb572601`, `667e8f198`                                                     | The update rail collapses to one status row ("Downloading…" then "Restarting…") and the skew banner stops being an amber warning. **Resolved Pylon-first:** upstream's bespoke `animate-status-pulse` dot is replaced by DotMatrix `spinner`/`error`, and the idle offer uses DotMatrix `idle` rather than a hollow dot — Pylon forbids continuously repainting animations, and status reads one way here. Pylon's step rail is retired with it.                                                                                     |
| E4         | `a483337a0`,`4f5834ba7`,`6da92244c` / `#4438`,`#5486`,`#5560`           | adopted  | `7fbf4492a`, `764df498c`, `aa7499061`                                        | Snooze respects the 12/24h format, the Woke badge becomes a dismiss button, and bulk snooze shows one toast instead of N. **Kept Pylon's `text-warning` token over upstream's amber literals and Pylon's full DotMatrix status switch** — upstream's lucide `CircleDashedIcon`/`CircleCheckIcon` were dropped. Zero user impact until `sidebarV2Enabled` stops defaulting false; taken for drift reduction.                                                                                                                          |
| E5         | `0ec4fbc4a`,`c471145e9`,`6fa457607` / `#5559`,`#5557`,`#5568`           | adopted  | `4f5489025`, `86191f7e1`, `ddc8c9605`                                        | Three Claude adapter fixes: commit/push/PR notices stop rendering as work-log errors, stopping a thread no longer surfaces an `ede_diagnostic` error, and stopped subagents settle. All three auto-merged despite `ClaudeAdapter.ts` carrying +598 lines of Pylon multi-account work. Claude is Pylon's primary provider, so this was the highest-value cluster in the batch.                                                                                                                                                        |
| E6         | `99d91ddaa` / `#5430`                                                   | adopted  | `e94cbe944`                                                                  | ACP approvals with unknown kinds stay actionable instead of rendering inert. Reaches Cursor and OpenCode.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| E7         | `ab3b55e29` / `#5431`                                                   | adopted  | `fb547c77f`                                                                  | Auto-permission copy now reads "Supported providers approve routine actions" instead of claiming an AI reviewer — more accurate for Pylon's five providers than upstream's. Landed inside `ChatComposer.tsx`, a deliberate Pylon divergence since C14.                                                                                                                                                                                                                                                                               |
| E8         | `331c6dce7` / `#5556`                                                   | adopted  | `26481d46a`                                                                  | Worktree creation skips the origin fetch in repos with no origin remote, which previously failed outright.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| E9         | `7aad7911f` / `#5553`                                                   | adopted  | `cad2747bf`                                                                  | Stopped threads settle immediately instead of waiting out the projection debounce.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| E10        | `6b73b3def` / `#5493`                                                   | adopted  | `3dc19b24a`                                                                  | Thread pagination with user-anchored turn windows: opt-in per request, gated behind a `threadSnapshotPagination` server capability so version skew is safe. **Upstream's migration `037_ProjectionTurnsKeysetIndex` was renumbered to 039** — Pylon already holds 037 (`ProjectionThreadsPinned`, itself renumbered in C5) and 038 (`ProjectionThreadsContinuedFrom`), and id 36 stays retired. Reusing 037 would have let those environments silently skip the keyset index.                                                        |
| E11        | `ae7b27de8`+`9547cf246` / `#5561`,`#5572`                               | adopted  | `5eb4f756b`, `4b368a83f`                                                     | Reconnect stops looping during server stalls (the vendored Effect patch gains 3-missed-pong tolerance plus ping/pong hooks) and one disconnecting client no longer blocks every other client's reconnect. **The patch was taken but the lockfile was regenerated with Pylon's pinned pnpm** (`ee2d74665`), not adopted from upstream; the resulting hash `af36b79…` matches because the hash is over the patch content. Pairs with D4.                                                                                               |
| E12        | `2288d416a` / `#5570`                                                   | adopted  | `3dc05ad02`                                                                  | The "requests are slow" warning stops firing on every provider update — a lying warning, which Pylon's taste rules single out.                                                                                                                                                                                                                                                                                                                                                                                                       |
| E13        | `1c7d059f5` / `#5566`                                                   | adopted  | `ce4e1a41f`                                                                  | Scrolling up during a running thread no longer snaps back to the bottom, on web and mobile.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| E14        | `cf5c9948c` / `#5569`                                                   | adopted  | `935a084b9`                                                                  | Agent panel rows stop reordering and changing height; the server ingestion change came along cleanly. Only the header doc comment conflicted, but **the marker grid track was widened from `0.375rem` to `0.875rem`** — upstream sized it for a 6px dot and Pylon's `StatusDot` is a 14px DotMatrix, which would have bled into the title column and defeated the fixed-height guarantee the grid exists for. Depends on D5.                                                                                                         |
| E15        | `1ffba7093`+`a8cd2ad2e` / `#5484`,`#5558`                               | adopted  | `37f6b60c5`, `fdfa7e220`                                                     | Plans fold into the transcript; see the note above for the storage-version and settings-removal consequences. `1ffba7093` is superseded by `a8cd2ad2e` and was taken only as its cherry-pick base. **Pylon's DotMatrix plan-step icons were carried from the deleted sidebar into the new inline `TurnPlanTimelineRow`** (done/spinner/idle), and the working row keeps DotMatrix `working` instead of upstream's three `animate-status-pulse` dots.                                                                                 |
| E16        | `64a991ad4` / `#5555`                                                   | adopted  | `763e8ca8d`                                                                  | Non-Git projects keep their environment selector instead of losing the whole toolbar. **Took upstream's `showGitControls` gating but kept Pylon's left-run layout and `ComposerUsageIndicator` placement**, including the branch selector's `justify-start`.                                                                                                                                                                                                                                                                         |
| E17        | `aa16c180e` / `#5495`                                                   | adopted  | `33150d526`                                                                  | Composer inline chips align with prompt text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| E18        | `ea50b695a` / `#5547`                                                   | adopted  | `202257cc3`                                                                  | The update tooltip stops dismissing when you scroll the release notes.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| E19        | `470d4eb99` / `#5450`                                                   | adopted  | `d14d8aefe`                                                                  | Mobile pending approval and input cards stop letting thread messages read through them.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| E20        | `ddfe45c66` / `#5350`                                                   | adopted  | `420c81e43`, `ee2d74665`                                                     | CI transfer-budget harness measuring per-thread network transfer — the natural guard for E1's win. The report heading was rebranded to Pylon since it renders into step summaries and PR comments; `T3CODE_TRANSFER_BUDGET_*` and the temp filename stay compatibility-named. **`thread-transfer-report.yml` is inert until it reaches `pylon`**: it checks out the publisher script from the default branch by design, so fork-PR runs never execute PR code. Revisit if its PR comments prove noisy at Pylon's contributor volume. |
| E21        | `4a07c1ca9` / `#5573`                                                   | skipped  | `—`                                                                          | Ships T3's production Clerk publishable key, `t3-relay` JWT template, and `relay.t3.codes` in `.env.example` so `cp .env.example .env` turns on T3 Connect. That points every fresh Pylon clone at T3 infrastructure; Pylon's cloud model is not T3's. Revisit only as a Pylon-owned equivalent with Pylon's own identifiers.                                                                                                                                                                                                        |
