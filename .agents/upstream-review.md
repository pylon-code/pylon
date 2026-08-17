---
remote: t3code-upstream
branch: main
reviewed-through: "bab4b6f02b8bdaf15fd32636a97f69ff657cec50"
reviewed-through-date: "2026-08-16"
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
needs an `origin/pylon` A/B, which was not run.

**Resolved on `fix/2026-08-07-timeline-positioning`.** Upstream had already
fixed the gross case in `b792ed9f7` / `#5449` ("stabilize chat timeline
positioning"), which landed just past this cursor. It moves web from
`@legendapp/list` 3.2.0 to 3.3.3 — Pylon's `apps/mobile` was already on 3.3.3,
so only web was running the older engine — and hands positioning to the
library, deleting 136 lines from `ChatView`. Cherry-picked clean; Pylon's
DotMatrix working row, plan-step markers and E10 `loadEarlier` wiring all
survived the rewrite.

That left a 5px residue: live follow lags the growing content by roughly
50 pixels while streaming, and the working row is both last and taller than a
text line, so its marker still touched the composer. `9c714b651` gives the row
its own bottom padding, taking measured clearance from -5px to a steady +13px.

Note for a later batch: bumping web to 3.3.3 means
`patches/@legendapp__list@3.3.3.patch` now applies to web as well as mobile.
It only touches `keyboard.*` and `react-native.*` entry points, which the web
build does not import, so it should be inert there.

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

## 2026-08-07 (second batch) — `a8cd2ad2ebb32ad789e8e0ecd2fc713c2edc38f4..72d673a855c730536f0cf3bb964ba523e0af9e2e`

Twenty-six upstream commits. `b792ed9f7` / `#5449` was already adopted out of
band on `pylon` (`184743cfc`, adapted, so `git cherry` still reports it as `+`),
leaving twenty-five candidates. Twenty adopted onto
`upstream/2026-08-07-batch-2` and five skipped. Upstream head moved from
`5661c6116` to `72d673a85` mid-review; the range and cursor use the later head.

Also considered and declined: upstream's `F1` dims the sidebar "Working" label
with `opacity-75` on threads the user is not reading. Pylon keeps every Working
label at full strength — the label already reads as one state, and dimming by
read-position adds a second meaning to the same token.

Verification: web, mobile, contracts, client-runtime, and desktop typecheck
clean; server typecheck reports only the pre-existing
`HostPowerMonitor.ts(69,9)` error, confirmed present on a clean `origin/pylon`
checkout with the same `node_modules`. Tests: web 2092, server orchestration and
persistence and provider 856 (6 skipped), mobile 617, client-runtime 591,
contracts 254. `vp lint` and `vp fmt --check` clean over all 171 changed files.
The lockfile was validated against Pylon rather than trusted from upstream; the
Clerk catalog bump in `F18` resolves identically, so no regeneration diff.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | --------------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1         | `3ffe84f96` / `#5580` | skipped  | `—`             | Upstream is only now removing the forever-shimmering sidebar "Working" label. Pylon already did this: the label is a steady `text-primary` DotMatrix and `--animate-sidebar-working-text` and its keyframes are already gone. Adopting would reintroduce upstream's `text-sky-600`/`dark:text-sky-400` and fight the five-color DotMatrix system. **Worth stealing separately: their `!isActive && "opacity-75"` idea.**                                                                                                                                                                                                                                                                                                                      |
| F2         | `61b51ae0e` / `#5578` | adopted  | `cb98eba5a`     | Clicking the pin icon unpins a thread.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| F3         | `239ef1c54` / `#5594` | adopted  | `9169ad617`     | The new-thread button's tooltip shows the shortcut that actually matches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F4         | `23f0a1ae3` / `#5579` | adopted  | `2b7178f4f`     | Reading a thread clears Done; the Woke badge becomes dismissible. Extends E4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| F5         | `5661c6116` / `#5581` | adopted  | `b7b0f0918`     | Pinned threads gain a user-defined drag order on a new `pin_order_key` column, on web and mobile. **Upstream's migration `038_ProjectionThreadsPinOrderKey` was renumbered to 040** — Pylon holds 038 (`ContinuedFrom`) and 039 (`TurnsKeysetIndex`), so reusing 038 would let those environments silently skip the column. Same reconciliation as E10. All five projection conflicts were both-sides-add; both fields kept.                                                                                                                                                                                                                                                                                                                  |
| F6         | `48aa875c0` / `#5551` | skipped  | `—`             | Removes the composer's Build/Plan toggle, restoring it behind a `planModeEnabled` Settings → Beta flag (default off). **Pylon keeps plan mode as a first-class composer affordance.** Upstream justified the removal with a chart showing ~3% of turns use plan mode, but that metric undercounts: a session that starts in plan mode spends most of its turns after approval, in build mode, so turn share is not session reach. Plan mode is also first-class in Claude Code and Codex, and drifting from the harness costs Pylon more than it costs T3 given the bring-your-own-subscription framing. Upstream's own PR drew sustained pushback on the same grounds. Revisit only if Pylon has its own evidence that the toggle is unused. |
| F7         | `b2ee17d7c` / `#5592` | adopted  | `424de9e2a`     | Thread actions reachable from the chat header title, not just the sidebar row — a second entry point for an existing behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| F8         | `2e66b1fdf` / `#5595` | adopted  | `028a48609`     | Live banners front the composer stack via a new `urgent` hint, so a passive "update available" notice can no longer cover background liveness and its Stop button; the collapsed stack cap now matches the hidden banner's variant instead of always reading amber. **Kept Pylon's DotMatrix over the `animate-status-pulse` dot in the context it landed in.**                                                                                                                                                                                                                                                                                                                                                                               |
| F9         | `95305c36f` / `#4479` | adopted  | `89fcba623`     | Provider settings become per-environment, extracted into `ProviderSettingsPanel.tsx`. **Manual port:** upstream deletes 683 lines Pylon had modified, so per-driver drain-order sorting, its reorder controls, and the `environmentId`/`timestampFormat` card props were re-homed into the new file. `timestampFormat` stays correct because it is a device-local client setting merged into every environment's view. Upstream's environment picker called `ConnectionStatusDot` with the pre-DotMatrix props, so `connectionPhaseDotMatrixState` was added beside the existing phase helpers.                                                                                                                                               |
| F10        | `85b1734d4` / `#5226` | adopted  | `50c97dcce`     | Modular theme library: built-in themes, custom editor, VS Code import, split light/dark halves, and semantic color tokens replacing ad-hoc opacity across ~40 files. **Landed last, after F9, since both rewrite `SettingsPanels.tsx`.** The working timeline row keeps Pylon's DotMatrix and its `pb-5` composer clearance rather than upstream's three staggered pulsing dots, but does adopt `text-secondary-label`. Visible "T3 Code" copy rebranded (import drop zone, Appearance description, built-in theme label — its id stays `default`); **`t3code:` localStorage keys and the `t3-grove` theme id are compatibility identifiers and were left alone**, since renaming them would orphan saved themes.                             |
| F11        | `7963cc70f` / `#5593` | adopted  | `51a470064`     | The server records runtime mode per turn and on mode changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| F12        | `72d673a85` / `#5270` | adopted  | `f507e175a`     | The Browser panel remembers recently used sites, keyed through the sidebar's project grouping so history follows the rows the user sees. Only an import block conflicted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F13        | `b98a0f0d2` / `#5563` | adopted  | `561f7b12d`     | Invisible Connect devices can be seen and removed on mobile — a missing reverse state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| F14        | `8100062a7` / `#5451` | adopted  | `6bfc80a8f`     | Mobile keyboard avoiding moves to the library, deleting 54 lines of hand-rolled logic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| F15        | `a17459e8a` / `#5440` | adopted  | `dc22439b8`     | iOS terminal no longer resets on clear.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| F16        | `33a03c8a7` / `#5415` | adopted  | `f70c15838`     | Mobile scroll views pad above the Android nav bar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| F17        | `bd422fd8d` / `#5582` | adopted  | `888e4c290`     | Android chat text stops showing through the composer. Adds a `@react-native/gradle-plugin@0.85.3` patch; **verified Pylon resolves exactly that version**, so the patch key matches and actually applies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F18        | `af281c9fc` / `#5140` | adopted  | `55901ac01`     | Repairs Clerk auth navigation headers on mobile and bumps the Clerk catalog. Lockfile validated against Pylon rather than trusted from upstream; catalog and lockfile agree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| F19        | `6d70e6d77` / `#5372` | adopted  | `c9c47f8f8`     | Reconnects no longer shift the mobile thread list. **Resolved Pylon-first:** took upstream's `WorkspaceConnectionTitle` wrapper, which is what stops the shift, and kept the Pylon mark and wordmark inside it rather than the T3 lockup. Prerequisite for F5's mobile half.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| F20        | `bfc69e4b4` / `#5588` | skipped  | `—`             | Bumps the mobile app version to 1.0.2. Pylon versions independently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| F21        | `388b43a27` / `#5584` | adopted  | `b1c515c2d`     | Faster dev cold-start: dep-cache warming plus gzip on Vite's dev server, which matters most over a shared origin where uncompressed JS is the whole cold start. Adds a `compression` dev dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| F22        | `a1762fdd7` / `#5586` | adopted  | `a45ace81d`     | `createDevRunnerEnv` strips `T3_SERVICE_LAUNCHER_CONTEXT` and `T3_BOOT_SERVICE_UNIT`, so a dev server spawned by an agent working inside Pylon stops dying with "the service launcher started a different t3 version". Replaces the long `auth pairing create` recipe with `node apps/server/src/bin.ts pair` (verified present at `apps/server/src/cli/pair.ts`). **Docs ported, not merged:** kept Pylon's rule that pairing tokens are secrets outside a deliberate handoff, took upstream's "never open a URL you handed to the user". `CLAUDE.md` symlinks to `AGENTS.md` and the two skill trees are hardlinked, so one edit covered every surface.                                                                                     |
| F23        | `be1a83674`           | skipped  | `—`             | Upstream v0.0.32 release prep. Pylon versions independently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| F24        | `e2cd2383c` / `#5637` | skipped  | `—`             | Vouches a T3 contributor in `.github/VOUCHED.td`. T3 contributor governance, no Pylon meaning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| F25        | `220efad62` / `#4511` | adopted  | `76dcb165f`     | Missing space before a link on the marketing download page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 2026-08-07 (third batch) — `72d673a855c730536f0cf3bb964ba523e0af9e2e..45d9aa90baab8f2d6b13c7ae3cf2f97128edaf7b`

Four upstream commits landed within hours of the second batch. Three adopted
onto `upstream/2026-08-07-batch-3`, one skipped. All four cherry-picked clean —
no adaptation was needed, which is expected this soon after the batch that
introduced the code they build on.

Verification: web typecheck clean; 2100 web tests pass, up from 2092 as these
commits bring 8 of their own. `vp fmt --check` clean over all ten changed files.

One pre-existing lint warning was surfaced and deliberately left alone — see the
note below the table.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                         |
| ---------- | --------------------- | -------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1         | `f0fb406ac` / `#5636` | adopted  | `f6134f8dc`     | Sidebar stage artwork becomes theme-aware. Its fixed Dev/Nightly colors clash with palette themes, so a palette theme now falls back to the theme-aware pill unless the theme opts in with `sidebarArtwork: true`; an explicit "none" is still honored. Extends F10 directly. Pylon's one-line `branding.ts` divergence is the stage label, which this does not touch. |
| G2         | `7a84f6cf1` / `#5633` | adopted  | `226bfa7e5`     | Locked composer context labels carry the `h-7 sm:h-6` control height. The context strip has no min-height of its own and the glass seam joining it to the composer assumes a fixed strip height, so a shorter label dragged the seam out of line on remote non-Git projects. Follows E16.                                                                              |
| G3         | `45d9aa90b` / `#5554` | adopted  | `cf6dc7c60`     | The Stop button stays visible while a provider input question is pending. Previously the pending-action branch returned early, so a running turn awaiting input had no stop affordance at all — a missing reverse state.                                                                                                                                               |
| G4         | `82406bce9` / `#5641` | skipped  | `—`             | Vouches a T3 contributor in `.github/VOUCHED.td`. T3 contributor governance, no Pylon meaning. Same class as F24.                                                                                                                                                                                                                                                      |

Left alone: `ThemeEditorPanel.tsx` carries an `oxlint-disable-next-line
exhaustive-deps` directive that `vp lint --report-unused-disable-directives`
reports as unused — the only such warning in `apps/web/src`. It arrived with F10
as upstream's own code and is untouched by this batch. It is inert here because
Pylon does not enable the React hooks rule it suppresses, which is also why
deleting it would be wrong: the directive becomes load-bearing the moment that
rule is turned on, and removing it now would silently hide a real dependency
bug later.

## 2026-08-08 — `45d9aa90baab8f2d6b13c7ae3cf2f97128edaf7b..2c7267ad43a05cf3e30343400c76fd9ac47698e7`

Six upstream commits, six change sets, all adopted onto
`upstream/2026-08-08-batch`. Four cherry-picked clean; `H1` and `H2` are
manual ports because both carry upstream's plan-mode retirement, which Pylon
declined in `F6` and declines again here.

Verification: typecheck clean across contracts, web, mobile, and desktop.
Tests pass — web 2093 (226 files), server 130 across the three touched
suites, contracts 33, mobile 37, desktop 7. `vp fmt --check` clean.

Two lint warnings were surfaced and deliberately left alone: the
`ThemeEditorPanel.tsx` unused-disable directive already documented under the
third 2026-08-07 batch, and an unused `pathname` in `SidebarChrome.tsx`.
Both are pre-existing and present upstream too; neither file is touched by
this batch.

Tooling note for the next session: run `vp` from the workspace, never from a
global vite-plus install. The global install ships its own vitest, so
entering through it puts two vitest instances in one run and every suite
collects zero tests with "Vitest failed to find the current suite" —
including tests that use no Effect layers. Which `vp` you enter through
decides this, and it propagates in-process through `vp run` into package
scripts, so prepending `node_modules/.bin` to `PATH` does not rescue an
invocation that already started global. A broken run does exit non-zero;
piping it through `tail` is what hides that, so read the summary line rather
than trusting a pipeline's status.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | --------------------- | -------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1         | `31891a1a0` / `#5664` | adopted  | `672b23192`     | Token-by-token assistant output moves into a new collapsed "Legacy features" section with a confirmation dialog, and `enableAssistantStreaming` becomes `enableLegacyTokenStreaming`. The rename is deliberate: decoding drops the old key, so prior opt-ins reset to buffered. Streaming costs one orchestration command, one websocket message, and one repaint per token, which is worst exactly where Pylon cares most. **Upstream's plan-mode row was dropped** — Pylon has no `planModeEnabled` flag and keeps plan mode first-class in the composer (extends F6).                                                                                                                                                                                                                                                                                                                                                                                                      |
| H2         | `0de954073` / `#5672` | adopted  | `75afe0ae0`     | The flat sidebar becomes the default; the per-project tree survives as `LegacySidebar` behind Settings → General → Legacy features. `sidebarV2Enabled`/`sidebarV2ConfiguredByUser` give way to a fresh `legacySidebarEnabled`, deleting the stage-based default from `branding.logic.ts`; Settings → Beta is gone and auto-settle moves to General; mobile mirrors it with `legacyThreadListEnabled`. **Reproduced as a three-way merge rather than a cherry-pick** so Pylon's DotMatrix status system carried across the `SidebarV2.tsx` → `Sidebar.tsx` rename instead of reverting to upstream's amber/indigo/sky hues; both resulting files differ from upstream by exactly Pylon's prior DotMatrix divergence and nothing else. `index.css` collapses the `[data-sidebar-version]` selectors onto `[data-app-sidebar]`, which Pylon's F10 theme rules already keyed on. Note both key drops are silent: prior opt-outs land on the new sidebar with no migration notice. |
| H3         | `4eaf5ef8b` / `#5673` | adopted  | `f0c33dbc2`     | PR status lookups stop amplifying GitHub rate limits. A throttled request is rejected immediately, so the flat 20s failure TTL made a rate-limited poller re-ask _faster_ than a healthy one and turned a transient 429 into sustained pressure; failures now back off per branch. Also skips the lookup entirely for branches with no remote-tracking ref, where the answer is a guaranteed-empty API call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| H4         | `ed886fe18` / `#5670` | adopted  | `bcbe5217b`     | A 2s grace before the "environment unavailable" banner, so a reconnect blip no longer flashes a hard failure. Version-skew reconnects still surface immediately, keeping the Reconnect action reachable. Matters more for Pylon than upstream: relay and tunnel connections blip routinely.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| H5         | `daf8ee0b2` / `#5628` | adopted  | `ff649bc4b`     | In simple typography mode the terminal inherits the code font size. It already inherited the code font _family_, so changing the code size silently left the terminal behind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| H6         | `2c7267ad4` / `#5677` | adopted  | `c2f0ddd96`     | The session reaper stops silently killing live background work. It only skipped threads with an active turn, but subagent fleets, workflow runs, and Monitor loops run on after the turn settles and nothing bumps `lastSeenAt` between turns — thirty idle minutes later `stopSession` tore down the provider process and everything inside it. Now skips threads with non-null `backgroundLiveness`. The liveness registry is in-memory, so orphaned bindings after a restart still get reaped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Two review findings on the adopted upstream code were fixed on this branch
rather than carried in: upstream's new unpublished-branch skip in `H3` also
fired for a branch whose remote head was deleted on merge and pruned (which
looks identical to never-published from remote refs alone), and recording
that skip as a null answer dropped the Merged badge and left the thread
waiting on a `changeRequestState` that never arrived; and `H2` never added
`legacySidebarEnabled` to `useSettingsRestore`, so Restore defaults left the
legacy sidebar on.

Known limitation carried in with `H6`, deliberately not redesigned here:
`ThreadBackgroundLiveness` holds no timestamps, and entries clear only on a
task-terminal transition or `session.exited` — `turn.aborted` has no case in
the ingestion switch. A background task that never reaches a terminal
transition therefore pins `backgroundLiveness` for the life of the server
process, and the reaper's new skip then disables the 30-minute idle backstop
for that provider session indefinitely. Bounding it needs a product call on
whether aborting a turn should also stop background work, so it is left as
upstream shipped it. Revisit if provider processes are seen surviving long
past their last turn.

## 2026-08-11 — `2c7267ad43a05cf3e30343400c76fd9ac47698e7..a7b0366cbe1e9eabc9e37eb079a38f6b6691f999`

Sixty upstream commits across roughly three days. Reviewed as one range and
adopted in themed slices rather than a single batch, so each slice landed
verified on its own. Final accounting: **50 adopted, 7 skipped, 3 deferred**
(`#4849` plus `#6049` as D1, and `#5991` recorded as inapplicable). Each slice
was pushed to `pylon` as a fast-forward after its own test, typecheck, lint,
and format run.

Skipped by decision (slice 7): `49964e38c` / `#5761` and `7b2cf4374` / `#5763`
(T3 contributor vouches, same class as F24/G4), `78f462c4e` (v0.0.33 release
prep — Pylon versions independently), `963ebf5bd` / `#5465` (label-gated
hosted-web preview deploys, T3 hosting), `73b2e8fdd` / `#5609` (automated
production mobile EAS releases), and `b91a000a1` / `#6013` (a duplicate action
on the T3-named default theme).

| Slice | Upstream                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Decision | Pylon reference                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | `deb901d63` / `#5538`, `062b4618c` / `#5782`, `2abe66800` / `#5916`                                                                                                                                                                                                                                                                                                                                                                                             | adopted  | `upstream/2026-08-11-slice1-security` / `56461413c` | Security and performance, all three clean cherry-picks. `#5916` adds `default-src 'none'; style-src 'unsafe-inline'; sandbox` to SVG asset responses; Pylon's `http.ts` was identical to upstream, so it applied unchanged. **This is the mitigation for `#5775`** (manually chosen project icons in S5): an SVG served same-origin can carry inline script, so S5 must not land without it. `#5538` stops favicon resolution pinning the event loop and `#5782` bounds the file-link label so bracket runs stop rescanning — both matter for Pylon's "performance without compromise" line.                                                                                                                                                                                                                                                                                                                                                |
| S2    | `e70cdb478` / `#5710`, `89c320df0` / `#5762`, `a6c9b41f9` / `#5757`, `5bb8c0366` / `#5774`, `ddaa6afef` / `#5773`, `ba9c9ae81` / `#5788`                                                                                                                                                                                                                                                                                                                        | adopted  | `upstream/2026-08-11-slice2-server` / `042b8bc5d`   | Server correctness, all six clean cherry-picks. `#5710` stops Claude resume handshakes completing turns that never ran; `#5762` lets a Codex thread with queued follow-ups actually stop; `#5774` adds an `onlyIfSettled` guard so settle-cleanup stops skip a thread re-engaged after the settle landed (new contracts field); `#5788` sets `OOMPolicy=continue` on the systemd unit, because agent tool calls share the server's cgroup and the kernel killing one greedy child was stopping the server, every live agent, and the user's connection; `#5757` lets agents open pasted images. `#5773` adds `vp run migrate-dev-db`, which **supersedes the hand-rolled `VACUUM INTO` recipe in the Test data section of the agent guidance** — it defaults to the T3-compatible `~/.t3` home, opens the source read-only, and refuses to rebuild the shared database, so it already obeys Pylon's "never write to the live install" rule. |
| S3    | 19 commits: `064041072` / `#5691`, `89ee692bf` / `#5731`, `c2f8cb7ca` / `#5745`, `5208bdeb0` / `#5767`, `6f69b4407` / `#5776`, `285cf5947` / `#5770`, `02f4ce566` / `#5860`, `659986ce3` / `#5857`, `c8ad4b813` / `#5074`, `83d769f02` / `#5841`, `cbd55d637` / `#5935`, `0ca9fb3fb` / `#5909`, `ef051bdb8` / `#5928`, `d43210050` / `#5879`, `f0e297518` / `#5864`, `3d74474f6` / `#5938`, `fbcae59ef` / `#5964`, `8de0aa24d` / `#5878`, `0a7c662d3` / `#6000` | adopted  | `upstream/2026-08-11-slice3-web` / `c273eb4db`      | Sidebar follow-ups and web/desktop polish, all nineteen clean cherry-picks with no DotMatrix overlap. `#5776` matters most: rows on the sidebar Pylon just made default were showing a truncated plan step where the branch belongs. `#5767` stops pinned reorder reshuffling while writes land and `#5909` restores the worktree icon. `#5928` enables Restore defaults after theme-mix changes, which sits beside Pylon's own `legacySidebarEnabled` restore fix. **Three commits in this slice were deferred, not dropped** — see the note below the table.                                                                                                                                                                                                                                                                                                                                                                              |

Deferred out of S3 to respect real dependencies, to be picked up after the
slice that supplies the file each one edits: `be01b287b` / `#5716`
(cursor-pointer styling) edits `usage/UsagePage.tsx`, which arrives with S4;
`05eb05118` / `#5777` (unsent drafts in the sidebar) needs the
`useHandleNewThread` rewrite from `6dbffa022` / `#5766` in S5; and
`9821bca1c` / `#5624` (themed confirmation dialogs) edits
`ProjectSettingsPanel.tsx`, which arrives with `288d8e345` / `#5768` in S5.
Each was attempted in chronological order, conflicted only on the missing
file, and was aborted cleanly rather than force-resolved.
| S4 | `8101cd044` / `#5684`, `a20923ce4` / `#5697`, `be01b287b` / `#5716`, `70c423a5e` / `#5756`, `886195ec1` / `#5772`, `1a003e383` / `#5743`, `bd18d8d6d` / `#5823`, `0d38866dc` / `#5887`, `9a1472d95` / `#5897` | adopted | `upstream/2026-08-11-slice4-usage` / `b95f5b356` | The usage dashboard, taken through its current head rather than at `#5684` alone — `#5823` rewrites `UsagePage.tsx` again and `#5887` fixes forked Codex sessions being double-counted, so adopting the first commit by itself would have shipped a state upstream had already replaced. Reads the provider CLIs' own on-disk transcripts, so it works per environment and covers turns never driven through Pylon; a good fit for the bring-your-own-subscription framing. Server, web, and mobile, plus a hoist of `usageFormat`/`usageMerge` into `packages/shared`. **`SidebarChrome.tsx` conflicted and was resolved Pylon-first:** took upstream's Usage nav entry and its icon import while keeping `PylonMark` over `T3Wordmark` and Pylon's `SidebarAccountDrainPill`. Four adopted comments were corrected — two named T3 Code for what is Pylon's own orchestration projection, and two claimed T3 Code writes the record-per-content-block repetition that the dedupe exists for, when that is Claude Code's transcript format. **Carries `usagePricing.ts`, a hardcoded price table that will drift as providers change pricing.** |
| S5 | `288d8e345` / `#5768`, `6dbffa022` / `#5766`, `05eb05118` / `#5777`, `076e9048d` / `#5775`, `f21d5e444` / `#5923`, `5da45337f` / `#5930`, `96906805f` / `#5929`, `9821bca1c` / `#5624` | adopted | `upstream/2026-08-11-slice5-projects` / `65a5747dd` | Project settings taken through its current head: `#5768` lifts project config out of the sidebar into a real settings page, then `#5923` replaces the two routes `#5768` had just added with contextual project routes and rewrites the panel, so stopping at `#5768` would have shipped a discarded intermediate. Also carries the two commits deferred out of S3, which applied cleanly once their prerequisites were in. **Both migration collisions reconciled:** upstream's `039_ProjectionProjectsDefaultThreadEnvMode` became `041` and its `040_ProjectionProjectFaviconPath` became `042`, because Pylon's ids run one ahead (36 is retired here) and 039/040 are already `ProjectionTurnsKeysetIndex` and `ProjectionThreadsPinOrderKey`. Reusing either id would let environments that recorded it silently skip the new column. The favicon migration's own test hardcoded upstream's `39`/`40`, so it asserted against a schema without the column and had to be repointed at `41`/`42` — the failure that caught it is exactly the risk renumbering carries. `Sidebar.tsx` conflicted once, on an import block where upstream drops the `Dialog` imports it no longer needs and Pylon's `DotMatrix` import sits alongside; kept `DotMatrix`, took the removal, and confirmed no `Dialog` references remained. Note `#5775` is the feature that makes S1's `#5916` SVG sandbox load-bearing. |
| S6 | `30164cb1b` / `#5625`, `f993fa1c5` / `#5901`, `67ef189d8` / `#5726`, `d440442db` / `#5659`, `428d9f9f6` / `#5613` | adopted | `upstream/2026-08-11-slice6-mobile` / `80e2c3bc0` | Mobile, five clean cherry-picks. `#5625` consolidates model and thread settings into one sheet; `#5613` adds an `withAndroidTabletOrientation` config plugin so Android tablets rotate. **Verified by mobile tests (623) and typecheck only** — `#5613` changes `app.config.ts` and adds a native config plugin, so rotation itself is unproven until an Android build runs, and the repo's native static check skipped SwiftLint/ktlint/detekt because none are installed here. |

`3b72d17cb` / `#5991` (parse EAS fingerprint JSON) was grouped into S6 but is
**not applicable**: it hardens `eas fingerprint:generate --json | jq -r '.hash'`
against eas-cli printing a notice before the JSON document, and Pylon's
`mobile-eas-production.yml` is its own workflow that never calls
`fingerprint:generate`. There is no line to fix. Revisit only if Pylon's
workflow later adopts that command.
| S7 | `1b120f352` / `#6034` | adopted | `upstream/2026-08-11-slice7-close` | Release publish timeout 10 → 30 minutes. Pylon's `release` job matched upstream's pre-fix state exactly — same `needs: [preflight, build, publish_cli]`, same 10-minute cap — and uploading desktop artifacts regularly outruns it, after a 90-minute build. **Resolved Pylon-first: took only the timeout**, keeping Pylon's own `if:` (a skipped CLI publish must not withhold the desktop release) and its GitHub-hosted `ubuntu-latest` runner rather than upstream's Blacksmith runner. Unlike `#5991`, this one had a real matching target. |

`cad2c9361` / `#4849` (multi-provider pull requests page with in-app reviews)
and its follow-up `a7b0366cb` / `#6049` were **deferred** rather than adopted
or skipped, and are tracked in the deferred register below. The cursor
advances because every candidate in the range now has a decision, and a
deferral is one.

## 2026-08-11 (second batch) — `a7b0366cbe1e9eabc9e37eb079a38f6b6691f999..9afef94a61466422128da9c3b723b633d4c7ed1d`

One upstream commit, one change set, adopted. Upstream has been quiet since the
sixty-commit range above closed.

DEF-1 was re-evaluated against this head and **stays deferred**: it requires
both of its gates and neither holds. The date is before 2026-08-25, and the
fourteen-day churn check on the pull-request page files still returns
`cad2c9361` and `a7b0366cb` themselves, so the surface has not settled.

Housekeeping found during preflight: the local `pylon` ref was 101 commits
behind `origin/pylon`, because the `subagent-observability` worktree held the
branch checked out and was last fast-forwarded on 2026-08-07 while the
2026-08-11 slices landed from the main checkout. Nothing was lost —
`origin/pylon..pylon` was empty — and the ref was fast-forwarded before this
batch branched. Worth remembering that a worktree holding `pylon` silently
pins it.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | --------------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1         | `9afef94a6` / `#5914` | adopted  | `64a2e27e9`     | Adds an "In 3 hours" snooze preset between "In an hour" and the calendar choices, closing a real gap: "This evening" is dropped once evening is near, so an early-afternoon snooze had nothing between one hour and tomorrow. Clean cherry-pick — all three touched files were byte-identical to upstream's parent. Every consumer maps the preset array generically, so the choice reaches the web sidebar row menu, the chat header menu, and the mobile swipe action without per-surface work. No DotMatrix, branding, migration, or contract overlap. |

Verification: the two snooze test files pass (32 tests) and mobile
`threadListV2.test.ts` passes (37 tests), since mobile resolves presets to
match its swipe events and a widened `SnoozePresetId` union reaches it. Web and
mobile typecheck clean; client-runtime reports only the pre-existing
`relay/discovery.ts(243,16)` Effect suggestion, in a file this change does not
touch. `vp lint` and `vp fmt --check` clean on all three changed files. A `vp i`
was needed first — the 101-commit fast-forward moved the lockfile substantially.

## 2026-08-11 (third batch) — `9afef94a61466422128da9c3b723b633d4c7ed1d..9c7622dac3d1a385351e6c74354a9e6b9c2037d5`

Seven upstream commits, all adopted, all fixes. These landed while the previous
batch was being verified — this machine fetches `t3code-upstream` on a timer,
so the head moved from `9afef94a6` to `9c7622dac` mid-session. Every one is a
correctness or performance fix with no branding, migration, versioning, or T3
infrastructure entanglement, and all seven cherry-picked without conflicts.

DEF-1 remains deferred; its gates are unchanged and this range does not touch
the pull-request surface.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | --------------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1         | `e5c82d79a` / `#5988` | adopted  | `25c645708`     | Mobile chat composer no longer sits under the Android gesture bar. Keys the safe-area inset on keyboard visibility via `useKeyboardState` rather than focus, because Android's back gesture closes the keyboard while the editor stays focused. **Verified the installed `react-native-keyboard-controller@1.21.13` exports the hook** — it is patched in Pylon, so the export could not be assumed from the version alone. |
| J2         | `2ea51bd31` / `#5072` | adopted  | `0d92f153d`     | OpenCode model parsing no longer drops models whose id contains a slash in the JSON body. Provider correctness, and the kind of adapter-boundary bug that is invisible until a specific model is used.                                                                                                                                                                                                                      |
| J3         | `59d0c922e` / `#5136` | adopted  | `4094c0b1a`     | The sidebar settled and snoozed shelves remember their collapse state across reloads — a reverse state that previously reset every session. Applied cleanly despite `Sidebar.tsx` being heavily diverged. **The `t3code:sidebar-v2:*` localStorage keys were kept**, consistent with the F10 precedent that `t3code:` storage keys are compatibility identifiers; renaming them would orphan preferences.                   |
| J4         | `f9730979c` / `#5220` | adopted  | `f37ac25ca`     | Skips base64 encoding for image candidates already over budget, estimating the data-URL length from blob size instead of encoding first. Changes `encodeWithinBudget` to return `null` rather than an over-budget encoding, so the caller drops it explicitly. Pylon had not diverged on this file.                                                                                                                         |
| J5         | `1fa315ea9` / `#5354` | adopted  | `3f456c2ce`     | Resource telemetry stops running Linux libc detection on Windows and macOS.                                                                                                                                                                                                                                                                                                                                                 |
| J6         | `c14bcca10` / `#5693` | adopted  | `b3d77dbea`     | Terminals advertise a 256-color `TERM` on Windows.                                                                                                                                                                                                                                                                                                                                                                          |
| J7         | `9c7622dac` / `#5944` | adopted  | `34f101f3a`     | VCS status handles an unborn HEAD, so a freshly `git init`-ed project with no commits stops erroring and falls back to `symbolic-ref`. `GitVcsDriverCore.ts` is diverged by 93 lines but the hunk applied cleanly; **both prerequisites (`isUnbornHeadStderr`, `runGitStdout`) were confirmed present in Pylon** before the pick.                                                                                           |

Verification: server tests for all four touched areas pass (70), web sidebar,
snooze, backdrop, and `useLocalStorage` pass (113), web `imageCompression`
passes (12). Web, mobile, and server typecheck report no errors — the server's
15 `TS377019` Effect suggestions are pre-existing and none is in a touched
file. `vp lint` and `vp fmt --check` clean across all 11 changed files.

Note for future sessions: `vp lint "$files"` with a newline-joined variable is
a silent no-op under zsh, which does not word-split unquoted expansions. It
prints `No files found to lint` and exits 0. Pass explicit paths and confirm
the reported file count.

## 2026-08-11 (fourth batch) — `9c7622dac3d1a385351e6c74354a9e6b9c2037d5..35172010b131510d36d0cef54e174926e38a3013`

Fourteen upstream commits. Twelve adopted, one deferred, and one skipped.

**Standing policy set this session: DEF-1 is wanted eventually, but not until
that surface is stable. Anything that depends on or modifies the pull-requests
page is deferred with it rather than skipped.** K13 below is the first
application of that rule.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | --------------------- | -------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1         | `6befe42eb` / `#6189` | adopted  | `c9aa8329d`     | A bare Windows drive root normalizes the same as `C:\` and `C:/`.                                                                                                                                                                                                                                                                                                                                           |
| K2         | `220e573b1` / `#6187` | adopted  | `b9a5fef90`     | Azure DevOps SSH remotes (`ssh.dev.azure.com`) are detected.                                                                                                                                                                                                                                                                                                                                                |
| K3         | `1e355a2a3` / `#6165` | adopted  | `510a4c673`     | Dropdowns render above toasts — a z-index fix across five UI primitives.                                                                                                                                                                                                                                                                                                                                    |
| K4         | `65b005f1e` / `#5574` | adopted  | `3e4a1737a`     | Copy Thread ID from both the sidebar row and chat header menus, hitting both entry points for one behavior.                                                                                                                                                                                                                                                                                                 |
| K5         | `57b105267` / `#6123` | adopted  | `9f5b17815`     | A dismissed thread error banner stays dismissed across reconnects and rerenders.                                                                                                                                                                                                                                                                                                                            |
| K6         | `35172010b` / `#6194` | adopted  | `4d317bb49`     | Clearer pull action icon. Touches `GitActionsControl`, not the pull-requests page, so it is unaffected by the DEF-1 policy.                                                                                                                                                                                                                                                                                 |
| K7         | `752acbf65` / `#5994` | adopted  | `8ac06fd34`     | Shift+click creates a new thread in the current project, with the shortcut shown in the tooltip.                                                                                                                                                                                                                                                                                                            |
| K8         | `ac4780f45` / `#6172` | adopted  | `5ee79111c`     | Typography rows report dirty on font _size_ changes, not just family, so Restore defaults reaches them. **One conflict in `SettingsPanels.tsx`, resolved Pylon-first:** upstream replaced four font-family checks with `getChangedTypographySettingLabels`, which is a superset of them; Pylon's own `showProviderUsageInContextPopover` label was kept alongside it.                                       |
| K9         | `44621c345` / `#6031` | adopted  | `7a32d19b9`     | **Manual port, usage half only.** Upstream adds sidebar-footer back buttons for both the usage and pull-requests pages; Pylon has no pull-requests page, so that branch and its `pullRequestsSupported` gating were left out. Uses Pylon's existing `useRouterState` pathname instead of upstream's `useLocation` selector. Closes a one-way door: the footer's Usage entry becomes Back while on `/usage`. |
| K13        | `f5fce7416` / `#6061` | deferred | `—`             | Routes self-hosted GitLab remotes, but patches `PullRequestService.ts`, which Pylon does not have. Deferred with DEF-1 under the standing policy rather than skipped, so it lands when the pull-requests surface does. Tracked as DEF-2.                                                                                                                                                                    |
| K14        | `3da7f9c5c` / `#6177` | skipped  | `—`             | Bumps the mobile app to 1.0.3 and adds App Store release guards to the EAS production workflow. Pylon versions independently (precedent F20, F23) and the guard is written around upstream's release cadence. Revisit only as a Pylon-owned release guard, not as a version bump.                                                                                                                           |

The three remaining candidates were decided in a follow-up pass and are
recorded below, which is what allows the cursor to reach `35172010b`.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | --------------------- | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K10        | `c842c6f5b` / `#6170` | adopted  | `718a9be1a`     | Hourly past-24-hour usage view across contracts, server aggregation, web, and mobile. Clean cherry-pick. **Incidentally repairs a corrupted file:** `usageAggregation.ts` carried three stray NUL bytes, which is why git diffs it as binary; the new revision is clean text. Upstream's own history shows the same binary diff, so this predates Pylon.                                                                                                                                                                                                 |
| K11        | `b30a9bc41` / `#6183` | adopted  | `833732cd1`     | Theme-aware environment artwork. Clean cherry-pick despite five diverged files. **Overlap reviewed before accepting:** the diff makes no contact with DotMatrix anywhere (no `DotMatrix`, `dot-matrix`, or `animate-status-pulse` reference), so Pylon's status language is untouched. Its real change is moving `sidebarArtwork` from a user-editable theme-file field to a maintainer-controlled built-in property — custom and imported themes can no longer opt in, and the five built-ins declare it instead. Pylon's F10 theme ids are unaffected. |
| K12        | `6676f9c83` / `#5986` | adopted  | `f2fa51c6d`     | Mobile composer and interaction stabilization: 37 files, four native patches, and a `@legendapp/list` 3.3.3 → catalog 3.3.5 move. **Confirmed the `package.json` edits are catalog moves, not app version bumps**, so the F20/F23 versioning rule does not apply. Adds `thread-settings-menu.ts` and `pendingUserInputLayout.ts` with tests. Verified on the iOS Simulator, not by typecheck alone — see below.                                                                                                                                          |

Verification: shared `path` and `sourceControl`, web `Sidebar.logic`,
`threadActionMenu.logic`, `SettingsPanels.logic`, and `ThreadErrorBanner` pass
(145 tests); usage and theme suites pass (79); mobile threads, lib, and updates
suites pass (231). Web, mobile, shared, and contracts typecheck clean; the
server reports no errors. `vp lint` and `vp fmt --check` clean across all 60
changed files.

K12 was additionally validated on a booted iOS Simulator against a disposable
environment: the dev client built and installed, paired to a seeded project,
and the draft composer, its safe-area toolbar clearance, and the new thread
settings menu all rendered and responded. No agent task was started, so nothing
ran against the working tree.

Setup notes discovered during that pass, since they will bite the next session:

- **CocoaPods needs a UTF-8 locale.** With `LANG` unset, `pod install` dies with
  `Unicode Normalization not appropriate for ASCII-8BIT` and the failure can
  surface as exit code 0 through a pipeline. Run iOS builds with
  `LANG=en_US.UTF-8`.
- **The `test-pylon-mobile` skill's iOS identifiers are stale for Pylon.** The
  real values are bundle id `com.pylon.code.dev`, scheme `pylon-code-dev`, and
  workspace `apps/mobile/ios/PylonDev.xcworkspace` — not the `com.t3tools.*`,
  `t3code-dev`, and `T3CodeDev` names the skill still documents. Note
  `apps/mobile/src/App.tsx` still registers `t3code://` linking prefixes, which
  is a genuine compatibility identifier and was left alone.
- **This simulator's HID backend rejects touch-move**, so `drag` and `swipe`
  fail with `FBSimulatorHIDEvent does not support touch move events`. Sheet rows
  that the accessibility tree does not expose are unreachable by gesture; deep
  links such as `pylon-code-dev://new/draft` are the reliable way in.

## 2026-08-11 (fifth batch) — `35172010b131510d36d0cef54e174926e38a3013..2db08457f2f4eaaa713a067b2ea480ca2b583025`

Two upstream commits, both adopted. **First batch to land through the pull
request workflow** rather than a fast-forward onto `pylon`, per the `Landing
changes` section added to `AGENTS.md` in PR #1. Each change set is its own PR,
so `L1` and `L2` may merge in either order.

DEF-1 and DEF-2 were re-evaluated against this head and both **stay deferred**.
Neither gate holds: the date is before 2026-08-25, and the fourteen-day churn
check on the pull-requests files still returns `cad2c9361` and `a7b0366cb`.
_Superseded the same day: the developer chose to adopt both anyway — see the
sixth batch below._

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | --------------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1         | `2db08457f` / `#6207` | adopted  | PR #2           | The Push quick action had no icon case and fell through to the generic `InfoIcon`; it now uses `CloudUploadIcon`, matching how push is already drawn elsewhere in the same file. Direct follow-up to K6 / `#6194`.                                                                                                                                                                                                                                                                                                                    |
| L2         | `083fa4ab2` / `#6036` | adopted  | PR #3           | Palette generation moves to OKLCH, adding `culori` and `@types/culori`. Clean cherry-pick despite five diverged files. **K11 / `#6183` is an ancestor of this commit**, which is why it applies against the theme-aware artwork adopted in the fourth batch — taking them out of order would have fought. **`index.html` verified Pylon-first:** the diff adds no visible T3 branding and leaves `<title>Pylon (Alpha)</title>` untouched; the `t3-chat-dark` id and boot-script comments are pre-existing compatibility identifiers. |

Verification: `themePalette`, `themeBoot`, `vscodeThemeImport`, and
`SidebarStageBackdrop` pass (78 tests). Web typecheck, lint, and format clean.

**Not proven by tests:** whether the five built-in themes still _look_ right
after the color-space change. Palette math that computes cleanly can still shift
perceptibly, so L2 wants one pass in a real client after merge.

## 2026-08-11 (sixth batch) — deferred work adopted: `#4849`, `#6049`, `#6061`

**DEF-1 and DEF-2 adopted, closing the deferred register.** The developer chose
to bring them in ahead of the recorded revisit gates, which had not come due —
the date gate was 2026-08-25 and the churn check was still non-empty. That is a
deliberate override, not a gate that passed, and it is recorded as such: the
pull-requests surface may still move upstream, so expect follow-up commits.

No new upstream range is involved, so the cursor does not move. Every commit
here sits at or before the current `reviewed-through`.

| Change set | Upstream                          | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                           |
| ---------- | --------------------------------- | -------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1         | `cad2c9361` / `#4849`             | adopted  | (this branch)   | Multi-provider pull requests page with in-app reviews: 143 files, 34,133 insertions, covering GitHub, GitLab, Bitbucket, and Azure DevOps providers plus the diff-comment review surface. Only **three** conflicts against a much-changed `pylon`, all resolved Pylon-first — see below. |
| M2         | `a7b0366cb` / `#6049`             | adopted  | (this branch)   | PR page header accounts for Windows window controls. Clean once M1 was in; it conflicted only because it patches a file M1 creates.                                                                                                                                                      |
| M3         | `f5fce7416` / `#6061` (was DEF-2) | adopted  | (this branch)   | Routes self-hosted GitLab remotes through the pull-requests service. Clean once M1 supplied `PullRequestService.ts`, which is exactly why it was deferred with DEF-1 rather than skipped.                                                                                                |

Conflict resolutions, all Pylon-first:

- **`index.css`** — upstream reintroduces `--animate-status-pulse` alongside a
  new `--animate-ghost-pulse`. **Only `ghost-pulse` was taken.** The new
  `PullRequestGhosts.tsx` depends on it in six places, whereas
  `animate-status-pulse` is the continuously repainting dot Pylon deliberately
  replaced with DotMatrix, and `ServerUpdateAction.test.tsx` asserts its
  absence. Pylon's `-1s` skeleton delay was kept over upstream's undelayed one.
- **`SidebarChrome.tsx`** — kept Pylon's usage Back button from K9 and added
  upstream's `pullRequestsSupported` Pull Requests entry. **This also completes
  `#6031`:** K9 took only its usage half because Pylon had no PR page, so the
  pull-requests Back button is now restored, giving that page the same way out.
- **`RightPanelTabs.tsx`** — kept Pylon's "Pylon desktop app" wording and took
  upstream's new `terminal` disabled-reason key, which neither side had before.

Verification: server `pullRequest` and `sourceControl`, contracts
`pullRequest`, and client-runtime `pullRequestDiffHttp` pass (496 tests); web
`pullRequest`, `diffs`, `openPullRequestLink`, `rightPanelStore`,
`reviewCommentContext`, `useLiveRefresh`, and `ServerUpdateAction` pass (198).
Contracts, client-runtime, web, mobile, and server typecheck with no errors —
the two `pullRequest` Effect diagnostics are upstream suggestions, not errors.
Lint clean and format clean across all 145 changed files. The generated
`routeTree.gen.ts` carries the new route.

Cheaper than the original DEF-1 assessment feared: **no lockfile change, no new
external dependency, no `vite.config.ts` change, and no migrations.** The only
manifest edit is a `./state/pull-requests` subpath export in
`packages/client-runtime/package.json`.

**Not verified:** nothing here was exercised in a real client. This adds a whole
product surface across web, desktop, and mobile, and its remote and
multi-environment behavior is untested in Pylon.

## 2026-08-12 (seventh batch) — `2db08457f2f4eaaa713a067b2ea480ca2b583025..c196f422ed387a1cc2cdb671b0472782e5610339`

Two upstream commits, both adopted, each as its own pull request. **This entry
was written after the fact:** the two PRs were built and merged without ledger
entries, so the cursor sat behind adopted work until this batch recorded it.
Fold the ledger update into the integration PR next time rather than trailing it.

The deferred register is empty, so there was nothing to re-evaluate.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | --------------------- | -------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1         | `f0b57ca23` / `#5654` | adopted  | `f681f9dbb`     | Open VSX theme search: in-app search and import of marketplace themes, ~2,700 insertions. Clean pick, since it is built on the OKLCH work already merged. **Flagged as a product decision, not a sync:** it is the first thing in Pylon that reaches a third-party marketplace at runtime, querying `open-vsx.org` and unpacking downloaded `.vsix` archives. Adds `jszip` and `jsonc-parser`. The developer accepted that tradeoff explicitly. No live marketplace call was exercised, so that path is covered only by the bundled tests.                                                                                                                                                                                                                                   |
| N2         | `c196f422e` / `#6209` | adopted  | `7b2adaf85`     | Composer context strip recomputes widths each pass instead of latching stale values, animated through the Web Animations API at 180ms and early-returning on `prefers-reduced-motion`. Fits Pylon's motion rules: bounded transition, not a continuous repaint. **`BranchToolbar.tsx` conflicted structurally and was resolved Pylon-first** — upstream pushes the branch selector right (`justify-end md:ml-auto`), Pylon keeps it in the left run (`justify-start`, E16) beside the workspace controls with Usage opposite. Only the animation machinery was taken: the `data-composer-context-control` markers, the strip's `overflow-x-clip overflow-y-visible`, and the motion constants. A comment now marks the divergence so a later merge does not quietly undo it. |

Verification: `BranchToolbar` (56 tests), `openVsxThemes`, `themePalette`,
`vscodeThemeImport`, `themeBoot` (85 tests). Web typecheck, lint, and format
clean on both branches. `jszip@3.10.1` and `jsonc-parser@3.3.1` confirmed to
resolve after install.

Landed alongside a Pylon-local fix (PR #7): the out-of-capacity handoff tab was
inset `right-3` (12px) against a `rounded-[22px]` composer frame, so it sat on
the corner arc where its square bottom edge could not meet a straight run and
read as detached. Moved to `right-6` (24px). Confirmed in a browser against the
live composer: computed radius 22px, tab right edge 12px in before versus 24px
after. `ComposerStashBadge` shares the same edge at `right-4` and is also inside
the radius, but is `rounded-full` so it does not misread; left alone
deliberately.

Tooling note for future sessions: `grep` in this environment can be a shell
function that silently returns nothing for some file queries. It fails as a
false negative, not an error, which makes "I searched and found nothing" claims
unsafe. Use `/usr/bin/grep` when a negative result is load-bearing.

## 2026-08-12 (eighth batch) — `c196f422ed387a1cc2cdb671b0472782e5610339..b73232bdd31e83914a8a943960c7dc4b6390b39b`

Twelve upstream commits, twelve independent change sets — no dependency chains
this round. Eleven adopted onto `upstream/2026-08-12-batch`, one skipped. Ten
cherry-picked clean; only `O1` conflicted.

The deferred register was empty going in, so there was nothing to re-evaluate,
and nothing new was deferred — it stays empty.

Upstream is in polish mode: nine of the twelve are `fix`, mostly single-file
alignment and overlap repairs. `git merge-tree` against `pylon` predicted the
conflict set up front, which made the split between clean picks and manual work
cheap to decide.

**`O1` is a product-direction change wearing a `feat` label.** It collapses the
sidebar footer's three labeled rows into one icon row and turns the update pill
into a round icon button that doubles as Check for updates. Ported by hand
because it collided with Pylon three ways: it deletes `useCanGoBack` and makes
Back always navigate to `/`, **reverting Pylon's own fix** for Back landing
somewhere the user never came from; Pylon's `SidebarAccountDrainPill` has no
upstream counterpart and had to stay in the footer stack; and the file also
holds `PylonMark`, so a careless resolution was a branding risk. Upstream's
removal of "Dismiss until next launch" was taken along with it — the pill is no
longer a full-width banner competing with the sidebar, so there is nothing left
to dismiss. `SidebarUpdatePill.tsx` was still byte-identical to upstream's
parent, so that half was taken wholesale rather than merged.

`animate-spin` on the refresh icon was kept rather than converted to DotMatrix.
It runs only while a check is actually in flight, so it is a bounded progress
indicator rather than the continuous idle repaint Pylon's motion rules forbid
(contrast `E3`, where upstream's forever-pulsing `animate-status-pulse` dot
_was_ replaced).

**`O7` shipped with a real defect, fixed on this branch rather than carried
in.** The new right-panel launcher claims bare B/T/F/D/P/A on a capture-phase
`window` listener and treated an empty contenteditable as "not typing". Pylon's
composer is a Lexical `ContentEditable` that is empty at rest, so with a thread
open and the right panel empty, a message starting with any of those six
letters lost its first keystroke to a surface opening instead — and
`stopPropagation` meant nothing downstream could recover it. A focused text
surface now always keeps its own keystrokes; the shortcuts still work when
focus is outside a text surface, which is the case the feature is for.

`O9` is a genuine upstream bug fix (`#5051`) but **inert in Pylon** until Pylon
owns a Clerk application — `E21` was skipped precisely so a fresh clone does not
point at T3 infrastructure. Taken for drift reduction in shared code. Its added
prose landed in a section Pylon had not rewritten, so the "Pylon Connect"
rebranding and the removed `.env.example` recipe both survived; the bare `#5051`
was qualified as an upstream issue link so it does not read as a Pylon issue.

Verification: typecheck clean across web, mobile, shared, and contracts. The
server package reports **0 errors** — only `effect` diagnostic _suggestions_, all
in files this batch does not touch. Note the pre-existing
`HostPowerMonitor.ts(69,9)` error recorded under the 2026-08-07 second batch is
gone; something since then fixed it. Tests: **web 2324 (244 files)**, **mobile
657 (105 files)**, shared `connectAuth` 7, server `publicConfig` 12 — all
passing. `vp lint` clean over all 33 changed TypeScript files and
`vp fmt --check` clean over all 36 changed files.

`O11`'s bundled test asserts ≥4.5:1 contrast across every built-in palette, and
it **passes against Pylon's F10-tuned palettes** rather than only upstream's —
that was the open question when this was recommended, and it is closed. `O2`'s
test reads `index.css` and regex-matches it; Pylon's `index.css` diverges
(DotMatrix keyframes replaced `status-pulse`), but both markers it slices
between survive, and it passes.

**Verified in real clients.** A web pass ran against a `VACUUM INTO` copy of the
developer's real database (9 threads), and an iOS pass ran on a purpose-booted
iPhone 17 Pro simulator. Migrations 37–42 applied cleanly over that real
database on first boot. Six change sets were confirmed against live behavior
rather than only by test:

- **O1** — the footer is one 48px row (`flex-direction: row`) with three 32px
  icon buttons, replacing three stacked labeled rows. Crucially, **the
  Pylon-first Back behavior was confirmed**: from a thread, Usage → Back
  returned to `/cec0464d…/6531739c…`, the exact thread, not `/`. Upstream's
  version would have landed on root. On a footer page the row correctly
  collapses to a single Back.
- **O2** — at the sidebar's 208px minimum, `.sidebar-brand` computes to
  `display: flex` and renders 58px wide. The retired 13.5rem (216px) container
  gate would have hidden it there.
- **O5** — the model picker's glyphs sit at x=294 against prompt text at x=293,
  a 1px delta; the button box still extends 10px further left for the hit
  target, which is the intent.
- **O7** — the launcher renders with its six Kbd badges, and availability
  gating is correct: `data-surface-launcher-keys="TFDA"` on a non-desktop
  client with no PR, so Browser and Pull request stay visible-but-disabled
  without claiming their letters. **Both guard paths were then confirmed** —
  with the empty composer focused, `t` typed into the composer and no surface
  opened; with focus on the launcher, `t` opened the Terminal. That is exactly
  the defect described above and its fix.
- **O12** — double-clicking the rail cleared the persisted width (`208` →
  `null`) and reset the live sidebar 208px → 256px.
- **O3** — a real end-to-end round trip on iOS. Long-pressing a thread row
  showed the native menu as Un-settle / **Regenerate title** / Delete, and
  tapping it regenerated the title through the provider: _"Fork T3 Code With
  Pylon Branding"_ → _"Build and Update Pylon Desktop Fork"_, with
  `title_regeneration_started_at` returning to `null` and the new title
  rendering in the list.

Still unproven, each with the reason:

- **O6 cannot be verified on this host at all.** It is gated to
  `Platform.OS === "android"`, so on iOS `includeOrderedLists` is `false` and
  the changed path is inert — an iOS pass gives it zero coverage. There is no
  Android SDK or `adb` on this machine. It rests on its unit tests until
  someone runs an Android emulator.
- **O11 and O8 are structurally unreachable locally.** `window.Clerk` is
  `undefined` because Pylon has no Clerk application (see `E21`), and the
  hosted-static onboarding route does not exist in local mode. Both need a
  hosted deployment, not a better test.
- **O10 was not reached.** Only one thread in the real database carries
  file-edit activities (80 of them), its earlier turns sit behind `E10`'s
  pagination, and the thread is heavy enough that driving it wedged the
  automation bridge twice. It rests on its class-level unit test.
- **O1's update pill was not exercised.** `SidebarUpdatePill` returns `null`
  outside Electron, so the round icon button, its checking spinner, and the
  release-notes tooltip need a desktop pass.

Incidental confirmation: `E10`'s "Load earlier turns" header renders on the
large thread, and `F10`'s themes plus this batch's palette work coexist without
a contrast regression.

Tooling note: `vp lint` exits **0 even when it reports warnings**, so its exit
code proves nothing. This session confirmed the command reports real findings by
feeding it a deliberate unused variable before trusting a clean result on the
changed files — worth repeating rather than reading silence as success. Separately,
`vitest` parses a leading-dash test filter (`-chatIndexTitlebar`) as a CLI flag
and dies; drop the dash.

Mobile-environment notes for the next iOS pass, both of which cost time here:

- **The mobile dev bundle id is Pylon-owned: `com.rynfar.pylon.dev`**, not the
  `com.t3tools.t3code.dev` that `test-pylon-mobile` documents. The URL scheme
  `t3code-dev://` _is_ still compatibility-named and works. Probing for the
  T3 bundle id reports "no dev client installed" on a simulator that has one.
- **`ios/Pods` goes stale whenever `vp i` changes a pnpm patch hash.** The Pods
  project hardcodes absolute store paths, so the build fails with "Build input
  files cannot be found" pointing at a `patch_hash=` directory that no longer
  exists (here `@react-native-menu/menu` moved `5ea3ae4bf…` → `c7f66d121…`).
  `pod install` fixes it and touches no tracked files. On this host CocoaPods
  1.17.0 additionally crashes under Ruby 4.0.6 with `Unicode Normalization not
appropriate for ASCII-8BIT` unless `LANG`/`LC_ALL` are set to a UTF-8 locale.

| Change set | Upstream              | Decision | Pylon reference          | Rationale or revisit condition                                                                                                                                                                                                                                                                                                  |
| ---------- | --------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1         | `52e5a75a8` / `#6210` | adopted  | `b0b11d966`              | Sidebar footer compaction; update pill becomes a round icon button that also checks for updates. **Manual port** — kept Pylon's history-preferring Back and `SidebarAccountDrainPill`, dropped upstream's now-pointless dismiss. Revisit if the icon-only footer proves less discoverable than the labeled rows.                |
| O2         | `560d4a456` / `#6246` | adopted  | `fecd9adb9`              | The sidebar brand stopped rendering at the sidebar's own minimum width. Pylon's mark plus "Pylon" is narrower than T3's wordmark, so removing the container gate is strictly better here.                                                                                                                                       |
| O3         | `d37a9b09b` / `#6253` | adopted  | `bda835962`              | Mobile gains thread title regeneration, closing a real multi-surface gap — web and the server capability (`threadTitleRegeneration`) already shipped it. Touches `docs/user/thread-sidebar.md`, which is the right home.                                                                                                        |
| O4         | `63e6faef6` / `#6259` | skipped  | `—`                      | Vouches a T3 contributor in `.github/VOUCHED.td`. T3 contributor governance, no Pylon meaning. Same class as `F24` and `G4`.                                                                                                                                                                                                    |
| O5         | `5a8461480` / `#6252` | adopted  | `60fdedec0`              | Composer model picker aligns with prompt text. Landed inside `ChatComposer.tsx`, a deliberate Pylon divergence since `C14`, but merged clean.                                                                                                                                                                                   |
| O6         | `e1378a1f4` / `#6154` | adopted  | `6304fa2b9`              | Android ordered lists stop escaping user bubbles. Gated to Android, where the shrink-to-fit layout bug lives.                                                                                                                                                                                                                   |
| O7         | `b54bfc931` / `#6258` | adopted  | `bbcb22eb4`, `560436ebd` | Right-panel empty state becomes a keyboard-first card launcher. Adopted, then its shortcut guard fixed on this branch — see the note above. Revisit if bare-letter shortcuts collide with anything else that lands in the panel.                                                                                                |
| O8         | `6fd088af9` / `#6293` | adopted  | `773487b9a`              | The hosted onboarding header uses the shared `workspace-topbar` geometry instead of its own padding.                                                                                                                                                                                                                            |
| O9         | `849bac894` / `#6285` | adopted  | `59fe87506`              | CLI OAuth parameters survive Clerk's sign-in redirect; the loopback flow routes through the hosted `/connect` page and rejects a corrupted port rather than silently downgrading. **Inert until Pylon owns a Clerk application** — taken for drift reduction. Revisit as part of any Pylon-owned Connect work, alongside `E21`. |
| O10        | `e321667b1` / `#6314` | adopted  | `31258d334`              | The changed-files header stops overlapping its own controls; `sm:` breakpoints become `@[24rem]/changed-files` container queries, which is correct for a panel that is not viewport-width.                                                                                                                                      |
| O11        | `f131228a5` / `#6300` | adopted  | `69acfbafc`, `7725de30a` | Clerk sign-in and profile surfaces inherit the live theme palette through CSS variables, so theme changes reach portaled Clerk UI without a remount. Its contrast test passes against Pylon's F10-tuned palettes. The doc comment's "T3 Code palette" was rebranded.                                                            |
| O12        | `b73232bdd` / `#6320` | adopted  | `78e415f87`              | Double-clicking the sidebar rail resets its width — the reverse of drag-to-resize. Keeps upstream's `console.error` in the reset's catch; it is an error report rather than debug output, but flagged since the repo bans stray console calls.                                                                                  |

## 2026-08-13 — `b73232bdd31e83914a8a943960c7dc4b6390b39b..bad1143b02f7b585d1fe1335b3d9a97983ce8d8b`

Twenty-six commits, twenty-four change sets, **twenty-two adopted and two
skipped**. Nothing deferred, so the register stays empty. `git cherry` reported
all twenty-six as `+`; none were patch-equivalent.

Conflict risk was **measured, not estimated**: every candidate was dry
cherry-picked against `origin/pylon` in a throwaway worktree before the brief
was written. Twenty-one of twenty-six applied clean, which is why a batch this
size was tractable.

The work landed as two stacked branches so the 12k-line `P1` could be reviewed
on its own: `upstream/2026-08-13-batch` (PR #12) carries everything else, and
`upstream/2026-08-13-pr-surfaces` (PR #13) sits on top of it. `P1` and `P2` name
their pull request rather than a commit, because a stacked branch is rebased
when the branch below it merges and any SHA recorded here would go stale.

| Change set | Upstream                                      | Decision | Pylon reference          | Rationale or revisit condition                                                                                                                                                                                                                                                             |
| ---------- | --------------------------------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1         | `b28f9bf0a` / `#6039`                         | adopted  | PR #13                   | Pull request surfaces: filters and qualifiers, all-server listing, update branch, reactions, in-place title/description/comment editing, checks popover, smarter diff file ordering. 86 files, +11,929, across contracts, all four PR providers, and web. One conflict only — see below.   |
| P2         | `92d4a2e99` / `#6490`                         | adopted  | PR #13                   | Scopes pull request errors to their environment, which only has meaning once the list spans several. Depended on `P1`: it conflicts in exactly the four files `P1` rewrites, and applied clean once `P1` was in.                                                                           |
| P3         | `8d24b5131` + `2eb099fdc` / `#6278` → `#6378` | adopted  | `5afaef758`, `9d3283ee9` | Cmd/Ctrl+click on a pull request link, and on a sidebar PR number, opens the host in the browser instead of the in-app panel. **Hard dependency**: `#6378` calls `shouldOpenPullRequestExternally`, which `#6278` introduces. Verified zero occurrences in Pylon first.                    |
| W1         | `770946d02` / `#6241`                         | adopted  | `af7299794`              | Tooltip positioner `z-70` → `z-[140]`. **A live Pylon defect, not just upstream's**: Pylon's popover, menu, select, combobox and autocomplete positioners all sit at `z-[130]`, so every tooltip rendered behind every dropdown. Upstream picked 140 for the same reason.                  |
| W2         | `9666b8751` / `#6343`                         | adopted  | `23ea93a87`              | Changing theme preserves appearance mode instead of re-inferring a fresh System preference, which could flip a dark UI to light. Matters more in Pylon, whose palettes are F10-tuned.                                                                                                      |
| W3         | `da6253b3d` / `#6230`                         | adopted  | `7bdbfce71`              | Source control discovery falls back to any connected environment, so the settings scan works on relay environments with no primary. A remote-mode defect, and Pylon is remote-ready.                                                                                                       |
| W4         | `1e59b4c40` / `#6393`                         | adopted  | `d454db255`              | The typed prompt survives a draft changing repo instead of being discarded.                                                                                                                                                                                                                |
| W5         | `860179723` / `#6322`                         | adopted  | `0507e4d95`              | Update toast "Read more" link and its arrow sit on one baseline.                                                                                                                                                                                                                           |
| W6         | `6bc6cb6be` / `#6423`                         | adopted  | `38aa57833`              | Diff file lists stay scrollable past an expanded file. Touches `StyledDiffCodeView.tsx`, which `P1` also edits; both applied clean in upstream order.                                                                                                                                      |
| W7         | `5015d7cf9` / `#6414`                         | adopted  | `0301c2627`              | Turn minimap stops shifting as the composer grows; the bottom-inset prop goes away in favour of `inset-y-0`.                                                                                                                                                                               |
| W8         | `97db94c9b` / `#6451`                         | adopted  | `9ef0cedca`              | Inline pull request panel gains `max-w-full` so it stays inside its workspace.                                                                                                                                                                                                             |
| W9         | `33f970592` / `#6385`                         | adopted  | `1c4b2917a`              | Reset-zoom control gets a visible hover state.                                                                                                                                                                                                                                             |
| W10        | `2fab18e28` / `#6509`                         | adopted  | `dc3fa038d`              | Aspect-ratio toggle shows an unlinked icon when unlocked. Upstream left a no-op `cn()` on the new branch — dropped on the adaptation commit.                                                                                                                                               |
| W11        | `ac1264e2c` / `#6330`                         | adopted  | `b095aa567`              | Command palette subtitles gain project favicons and workspace icons. Shipped a `THREAD_COMMAND_SUBTITLE_VARIANT` "flip this while reviewing" knob with three variants, but nothing outside the file ever passed one — **collapsed to the shipped variant** on the adaptation commit.       |
| W12        | `2ab188f1c` / `#6476`                         | adopted  | `313235bd3`              | The slow-RPC latency tracker ignores `pullRequests.*` methods, which legitimately take seconds because they reach a remote host. Without it the tracker reports a lying "slow request" every time the PR list loads. Pylon has 13 such methods, so the test's `it.each` is non-empty here. |
| C1         | `d0b8d6306` + `1b16ed663` / `#4844` → `#6442` | adopted  | `9c9191d68`, `e164cf972` | Deregister account environments from any client, on a new shared `ClerkUserProfilePage` shell. **Inert until Pylon owns a Clerk application**, same standing as `O9` and `E21`; taken for drift reduction. `#6442` patches a file `#4844` creates, so it is a chain.                       |
| S1         | `df19f6cfe` / `#6432`                         | adopted  | `5436e201a`              | Codex collaboration prompt tuning: plans get shorter and less file-by-file, and `request_user_input` availability is described by tool listing rather than by mode. Provider-prompt maintenance — drifting from upstream's Codex tuning has no upside.                                     |
| M1         | `83ad26c3a` / `#6495`                         | adopted  | `fd0caec18`              | **Crash fix.** Out-of-range numeric HTML entities made `String.fromCodePoint` throw a `RangeError` and took down the whole mobile markdown block. Now the malformed entity is left as literal text.                                                                                        |
| M2         | `fd51561b4` / `#6482`                         | adopted  | `72cfb55bd`              | Blockquote markers extend across wrapped lines; blockquotes become rich blocks and table cells render as documents. Pylon's `nativeMarkdownDocumentRuns` already took the `skills` parameter this relies on.                                                                               |
| M3         | `18918d1c4` / `#6370`                         | adopted  | `1caf2eb2a`              | Mobile command popover uses the shared `GlassSurface` instead of its own `LiquidGlassView`/`View` fork. Net −19 lines.                                                                                                                                                                     |
| M4         | `bad1143b0` / `#6520`                         | adopted  | `7c2569d5b`              | Android sidebar header shows a real settings cog by deleting the native header-button override and falling back to the shared path. Pure deletion, −223 lines. Verified every `T3HeaderButton` reference in Pylon sits inside the deleted set. **Not exercised on an Android emulator.**   |
| T1         | `e3a9c2518` / `#5155`                         | adopted  | `f4b9a6c91`              | Mobile showcase seeds snoozed threads. Dev tooling only; Pylon's migration 034 supplies `snoozed_until`/`snoozed_at`, and the script PRAGMA-guards for them anyway.                                                                                                                        |
| X1         | `9e201941a` / `#6479`                         | skipped  | `—`                      | Removes "Rebase onto latest main before opening" from upstream's `AGENTS.md`. Pylon deliberately rewrote that line to point at `pylon`, and `CLAUDE.md` mandates the rebase. Adopting it would contradict Pylon's own landing workflow.                                                    |
| X2         | `9513e62e2` / `#6462`                         | skipped  | `—`                      | Vouches a T3 contributor in `.github/VOUCHED.td`. T3 contributor governance, no Pylon meaning. Same class as `O4`, `F24`, and `G4`.                                                                                                                                                        |

Conflict resolutions, both Pylon-first:

- **`MobileClientsUserProfilePage.tsx`** (`C1`) — Pylon had already rebranded
  copy that upstream restructured into the new `ClerkUserProfilePage` shell.
  Took upstream's structure and typography, kept Pylon's "Pylon" and "Pylon
  Connect" wording.
- **`SidebarChrome.tsx`** (`P1`) — Pylon gated the pull requests link on the
  **primary** environment's capability; upstream widens it to **any** connected
  one. Resolved toward upstream, because all-server listing is the feature.
  Upstream's version also adds a `useLocation` subscription to name the current
  footer page, but Pylon already derives that from its own `pathname` and only
  needs the boolean, so the duplicate subscription was dropped rather than
  added.

Rebranding, per the usual split between product copy and compatibility names:
`T3 Code` → `Pylon` and `T3 Connect` → `Pylon Connect` in all visible copy,
including the new account-menu page label and `docs/user/remote-access.md`. The
`T3Connect*` filenames and the `t3-connect` route slug stay, matching the
existing `T3ConnectSidebarSignIn.tsx`. `app.t3.codes` was left alone — it is the
inherited hosted origin, not branding.

Verification: 301 tests over 11 files on PR #12, 887 tests over 30 files on
PR #13, both green; typechecks clean on `@t3tools/web`, `t3`, `@t3tools/mobile`,
`@t3tools/client-runtime`, `@t3tools/contracts`, with only pre-existing
`suggestion`-level Effect hints; lint clean apart from two deliberate
`no-array-index-key` warnings in `P1` that upstream documents (the host decides
how many check runs share a name, so position disambiguates a name-and-url key).
**Neither branch has had a real-client pass**; `P1` is the one that most wants
one.

Two tooling notes worth carrying forward:

- **A green `vp test run` exit code can hide failures.** The first run on PR #12
  exited 0 with five tests failing. This is a second instance of the family the
  eighth batch recorded for `vp lint`, and it argues for reading the
  `Test Files`/`Tests` summary line every time rather than trusting `$?`.
- **`vp i` copies workspace `file:` dependencies into the pnpm store rather than
  symlinking them.** `apps/mobile/modules/t3-markdown-text` resolves through
  `node_modules/.pnpm/@t3tools+mobile-markdown-text@file+.../src/`, a snapshot
  taken at install time. Installing _before_ cherry-picking meant the mobile
  markdown tests ran against pre-cherry-pick source and failed against the
  updated expectations. **Re-run `vp i` after changing one of these modules.**

## 2026-08-14 — `bad1143b02f7b585d1fe1335b3d9a97983ce8d8b..5304f3e9d4c912bfa0eb2f5f41fa109b3646236b`

Six commits, six change sets, **four adopted and two skipped**. Nothing
deferred, so the register stays empty. `git cherry` reported all six as `+`.

Conflict risk was measured by dry cherry-pick against the merged `pylon` before
the brief was written: four clean, two conflicting — and both conflicts landed
exactly on Pylon-owned boundaries, which is the system working.

Adopted across two branches, split by surface rather than by size:
`upstream/2026-08-14-web` (PR #15) and `upstream/2026-08-14-mobile` (PR #16).

| Change set | Upstream              | Decision | Pylon reference          | Rationale or revisit condition                                                                                                                                                                                                                                                                                      |
| ---------- | --------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1         | `db1507e98` / `#5880` | adopted  | `07a3a846c`              | A setting to stop threads auto-settling when their pull request merges. Additive `sidebarAutoSettleOnMerge`, **default `true`**, so existing behaviour is unchanged; closed pull requests still always settle. Upstream covered contracts, client-runtime, web, and mobile.                                         |
| N2         | `96bfa67b3` / `#6215` | adopted  | `fb284b0f9`              | Snoozed-thread wake icon sits on the row's optical centre. Generic geometry, applies to Pylon's sidebar unchanged.                                                                                                                                                                                                  |
| N3         | `23d45d914` / `#6535` | adopted  | `570b54268`, `f7311ad81` | Stage artwork palette rework: explicit night pigments plus glow and sparkle, with the old `color-mix` derivation scoped to `t3-chat`, `ocean`, and `iris` — all of which Pylon still ships. Its "T3 Code artwork palettes" comment was rebranded, following `O11`.                                                  |
| N5         | `85389b988` / `#6224` | adopted  | `bbd3db454`, `5990b2440` | Mobile task and thread settings nest in bottom sheets. 41 files, +3,652/−1,836, **including native patches** to `react-native-screens` and `@react-navigation/native-stack`. Verified by a real prebuild, `pod install`, native build, and simulator pass — see below.                                              |
| N4         | `5ff3a03ad` / `#6086` | skipped  | `—`                      | Adds `-translate-y-px` to the sidebar brand label. A 1px optical correction measured against `<T3Wordmark />`; Pylon renders `<PylonMark />` plus the word "Pylon", a different glyph. **Cherry-picks clean and is still wrong for the fork.** Revisit only as Pylon-owned alignment work against Pylon's own mark. |
| N6         | `5304f3e9d`           | skipped  | `—`                      | Bumps the mobile app version to `1.0.4`. Pylon's `app.config.ts` is independent (`slug: "pylon"`, `pylon-code*` schemes, version `1.0.1`), so the bump conflicts and carries no Pylon meaning. Same class as any T3 release chore.                                                                                  |

**`N5` corrected a stale fact this ledger itself recorded.** The ninth batch's
mobile notes said the `t3code-dev://` URL scheme "is still compatibility-named
and works". It does not. A built `PylonDev.app` registers exactly
`pylon-code-dev` and `com.pylon.code.dev`:

```
$ plutil -extract CFBundleURLTypes json -o - .../PylonDev.app/Info.plist
[{"CFBundleURLSchemes":["pylon-code-dev","com.pylon.code.dev"]},{"CFBundleURLSchemes":["exp+pylon"]}]
```

`apps/mobile/src/App.tsx` still lists `t3code-dev://` among React Navigation's
linking prefixes, which is likely how the belief survived, but iOS never
delivers an unregistered scheme so the prefix is unreachable. Upstream's new
`pair-client.sh` defaulted to that scheme and hardcoded `com.t3tools.t3code.dev`,
so it would have failed silently on Pylon. The helper, the `test-pylon-mobile`
skill's identity block, and its `T3CodeDev.xcworkspace` references were all
corrected to what `app.config.ts` produces: `Pylon Dev`, `com.pylon.code.dev`,
`pylon-code-dev`, `PylonDev.xcworkspace`, scheme `PylonDev`.

Verification: 264 tests over four files and five clean package typechecks on the
web branch; 40 tests over six files and a clean mobile typecheck on the mobile
branch; `vp lint` clean on both. `N5` additionally got a full native rebuild and
an iOS Simulator pass — build succeeded in 176s with the new patches, the app
launched as `com.pylon.code.dev`, the corrected deep link routed, and both the
Add Environment route and the new "Choose project" context picker rendered as
nested bottom sheets. `N3` was captured before and after on one dev server by
swapping `index.css` over HMR, so the comparison holds data and layout constant.

**Android was not exercised for `N5`**, and the thread-settings sheet was not
driven on a live thread because the simulator was reconnecting to a
previously-paired real environment.

Two environment notes worth carrying forward:

- **CocoaPods 1.17.0 crashes under Ruby 4.0.6** with `Unicode Normalization not
appropriate for ASCII-8BIT` when `LANG`/`LC_ALL` are unset, which is how
  `expo prebuild` leaves the shell. The ninth batch predicted this; setting a
  UTF-8 locale for `pod install` fixes it. `expo prebuild` **exits 0 even when
  its CocoaPods step fails**, leaving `ios/` without an `.xcworkspace`.
- **`apps/mobile/package.json`'s `dev:client` script still passes
  `--scheme t3code-dev`**, which no longer matches the registered native scheme.
  Left alone as out of scope for an adoption batch, but it is a real bug worth
  its own fix.

## 2026-08-14 (eleventh) — `5304f3e9d4c912bfa0eb2f5f41fa109b3646236b..1a6599437b6ad77330923819613cc28be3b33945`

Fourteen commits, twelve change sets, **all twelve adopted, none skipped**. Nothing
deferred, so the register stays empty. `git cherry` reported all fourteen as `+`.

Dry cherry-pick against `pylon` before the brief: ten clean, four conflicting —
and every conflict was either Pylon's own rebrand or a missing chain anchor.

Landed as four branches split by surface: `upstream/2026-08-14-web-fixes` (PR #21),
`upstream/2026-08-14-mobile-batch` (PR #24),
`upstream/2026-08-14-preview-browser` (PR #22), and
`upstream/2026-08-14-windows-asar` (PR #23).

| Change set | Upstream                                      | Decision | Pylon reference                       | Rationale or revisit condition                                                                                                                                                                                                         |
| ---------- | --------------------------------------------- | -------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1         | `59be6f784` / `#6549`                         | adopted  | `f5008cefa`                           | Simplifies the desktop-managed update copy. Conflicted only because Pylon had rebranded the string; upstream's replacement names no product, so adopting it **removes** a divergence point.                                            |
| E2         | `e15f655ba` / `#6506`                         | adopted  | `8926156d4`                           | Background-policy tooltips appear sooner. One line.                                                                                                                                                                                    |
| E7         | `4a2f8b04b` / `#6281`                         | adopted  | `585b39d80`                           | Thread rename survives IME composition — a real defect for CJK input, where composition previously committed the rename mid-word.                                                                                                      |
| E10        | `038560e58` / `#6592`                         | adopted  | `0672c58f9`                           | Every titlebar control cluster shares one inset.                                                                                                                                                                                       |
| E12        | `1a6599437` / `#6504`                         | adopted  | `ff516dc91`                           | Desktop update state gets a dedicated status icon and clearer pill. Verified it does not reintroduce the dismiss that `O1` deliberately dropped.                                                                                       |
| E5         | `baaeda305` / `#6325`                         | adopted  | `76b236552`                           | Descriptor stops advertising agent-activity publishing without the opt-in secret **and** relay credentials. **More relevant to Pylon than upstream**: the bug fires exactly when relay credentials are absent, which is Pylon's state. |
| E6         | `8f9ab0845` → `6ae44b418` / `#6587` → `#6589` | adopted  | `49979651a`, `7df944357`              | Git-progress overlay spacing, then naming the iOS nav-bar fallback. **Chain** — #6589 conflicts alone because #6587 introduces the neighbouring constant.                                                                              |
| E8         | `b3b4b5779` / `#6323`                         | adopted  | `9ac000edd`                           | Preserves keyboard suggestions while typing. Touches native Swift and Kotlin; **native rebuild blocked by a full disk**, see below.                                                                                                    |
| E9         | `21a3669ce` / `#6324`                         | adopted  | `70c06e123`                           | OTA restart crash fix. **Dormant** while Pylon's OTA is off (`PYLON_EAS_PROJECT_ID` unset), but the same commit hardens atomic writes, composer drafts, and the thread outbox against any mid-write kill, which is not dormant.        |
| E11        | `184d8ef33` / `#6543`                         | adopted  | `fc8f7cc22`                           | **Steer active turns by default** — a queued message now sends while a turn runs. A product decision the developer explicitly asked for. **Manual port**, see below.                                                                   |
| E3         | `710fd0eeb` → `9fd788b5a` / `#5644` → `#6021` | adopted  | `5d0ce44f7`, `523f80332`              | Browser-panel favicons, then listing only browser-ready local servers. Chain, 5,254 insertions across 40 files.                                                                                                                        |
| E4         | `7e01d33f0` / `#5877`                         | adopted  | `a71e11c27`, `50e20e926`, `c775d1530` | Windows asar stops unpacking `node_modules` wholesale. Pylon's desktop identity lines are untouched by the diff. **Windows packaging unverifiable from macOS** — `Release Smoke` is the gate.                                          |

**E11 required a manual port.** Upstream deletes `activeThreadBusy` outright and
renames `localOutboxCount` to `queueCount`. Pylon still needs `activeThreadBusy`
to gate session-resource reload and agent depth, and its composer has diverged
further via the Prime Agent work in `#17`. Taken: `thread-outbox-model.ts`, its
tests, and the drain simplification. Rejected: every composer/screen edit that
removes the prop. Adapted: Pylon's send label said "Save pending send" when busy,
which steering makes a lie, so `activeThreadBusy` was dropped from that condition
only — the other two uses stand.

**E3's second conflict was substantive.** Pylon showed listening state via
`DotMatrix` dots and a three-way label; `#6021` replaces the indicator with the
favicon and collapses the label, because non-listening servers no longer appear.
Took upstream's side: with stale servers filtered out, the dot distinguishes
nothing. `PulsingDot`, `DimDot`, and the `DotMatrix` import went dead and were
removed; `BrowserMockup`'s import was already dead beforehand.

Three process notes worth more than the commits:

- **`git checkout --theirs` takes the whole file, not the hunk.** Using it on
  `versionSkew.ts` for `E1` silently reverted three unrelated Pylon rebrands
  (`"the same Pylon version"` → `"the same T3 Code version"`) in user-visible
  copy. Caught by diffing the branch against `pylon` and finding unintended
  changes. **Resolve hunks, then diff the branch against `pylon` before
  trusting the result.**
- **A conflict probe is only as good as its resolution.** The pre-review probe
  reported `#6021` clean on top of `#5644`; that was an artifact of resolving
  `#5644` with `--theirs`. With the correct resolution it conflicts.
- **`vp test run` before `vp i` finishes fails misleadingly.** Six mobile test
  files "failed" purely because the install was still running; all 123 passed on
  re-run. Second occurrence of this; the ninth batch recorded the same trap.

**Host disk hit 99% (9.5 GB free) mid-batch**, and `pod install` died with
`no space left on device`. That is why `E8`'s native half has only static
verification. The largest reclaimable item is
`~/Library/Developer/XcodeBuildMCP/workspaces/pylon-192ff3ff7a51` at 9.5 GB —
regenerable DerivedData, but shared across sessions for this repo, so it was
left alone rather than deleted unasked. Note that `du` overstates worktrees
badly: pnpm hardlinks from a shared store, so removing a 6.7 GB worktree freed
about 0.1 GB.

Verification: 7 tests on PR #21, 123 on #24, 234 on #22, 57 on #23; typechecks
clean across web, mobile, contracts, client-runtime, desktop, and `t3`; `vp lint`
clean on all four branches after fixing three `no-useless-fallback-in-spread`
warnings that `#5877`'s new test introduced. **No browser pass on `E3`, no native
pass on `E8`, no Android anywhere.**

## 2026-08-14 (twelfth) — `1a6599437b6ad77330923819613cc28be3b33945..1add47b322ab1dfb5010bb363613650176b88088`

Two commits, two change sets, **both adopted**. Nothing deferred. Neither was
patch-equivalent, and both dry cherry-picked clean against `pylon` — no Pylon
adaptation was needed for either.

Both are terminal work but different concerns, so they landed as two branches:
`fix/terminal-pid-flood` (PR #25) and `feat/terminal-copy-shortcut` (PR #26).

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | --------------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1         | `80991402d` / `#6377` | adopted  | `2a8dd3cc4`     | Terminal subprocess polling spawned a process **per terminal per poll** at a 1s cadence (`pgrep` + `ps`, or `powershell.exe`). Now one `ps` snapshot of the whole table per cycle, with each terminal's subtree derived in memory: per-poll spawns drop from O(terminals × commands) to O(1). Also drops `pgrep` and resolves `ps` to an absolute path once, since spawning by bare name burns a failed `posix_spawn` per `PATH` entry. A defect whose blast radius reaches outside Pylon. |
| T2         | `1add47b32` / `#5638` | adopted  | `cd3b7cb8b`     | Plain `Ctrl+C` copies a terminal selection on non-mac, where only `Ctrl+Shift+C` did before. **Verified it does not break SIGINT**: the copy path is gated on there being a selection, so an empty selection falls through to the shell, and a plain non-mac copy clears the selection so the next press interrupts. `Cmd+C` and `Ctrl+Shift+C` stay copy-only. Tradeoff: with text selected the first press copies rather than interrupts.                                                |

`T2` leans deliberately on engine differences — plain `Ctrl+C` is left
un-prevented so the native copy event fires, with a token-guarded deferred
`clipboard.writeText` racing it for WebKit (which omits the keyboard copy event
without a DOM selection), while `Ctrl+Shift+C` synthesises one via
`execCommand("copy")` because Chrome binds that chord to inspect. **Unit tests
cannot settle that race; no browser pass was run.**

Verification: 54 tests on PR #25 (the commit ships 120 lines of new ones), 47 on
PR #26; typechecks clean on `t3`, `@t3tools/web`, `@t3tools/contracts`; `vp lint`
clean on both branches. **Neither got an integration pass** — no live multi-terminal
session for `T1`, no Chrome/Safari clipboard check for `T2`.

## 2026-08-15 (targeted) — `1add47b322ab1dfb5010bb363613650176b88088..ad117235b544e23545fe39143812db2ddd41af1f`

**Cursor deliberately not advanced.** This was a targeted review, not a full
batch. The developer asked whether upstream held a fix or a cause for an iOS
crash on opening a session, so only mobile-relevant work was assessed. The
remaining candidates in this 99-commit range are undecided, and
`reviewed-through` stays at `1add47b32` until they are.

Answer to the question that prompted it: **no**. The range holds exactly one
mobile crash fix, `#4899`, and it guards sign-out in `SettingsAuthRouteScreen`
— a different code path from opening a session. `git cherry` reports all 99
commits absent from Pylon, so upstream work in this range cannot have caused
the regression either; the crash window is Pylon's own
`4c1830c6..24aac6537`. Every `patches/` entry except `@ff-labs__fff-node` is
identical to upstream, which rules out patch divergence as the cause.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                        |
| ---------- | --------------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1         | `277a7cb44` / `#4899` | adopted  | `3b2b8d512`     | Signing out of the mobile settings account screen crashed: `UserProfileView` unmounts the instant `isSignedIn` flips false. The fix latches `hasBeenSignedIn` and pops back to `SettingsContent` instead. Clean single-file cherry-pick. Newly reachable for Pylon — mobile Connect sign-in only began working today, so this screen had never been exercised before. |

Deferred register: unchanged and still empty.

## 2026-08-15 (full batch) — `1add47b322ab1dfb5010bb363613650176b88088..a5e29edeec34fdfab1d44e643b0d12bb924fd261`

One hundred upstream commits. `277a7cb44` / `#4899` was already adopted out of band
earlier the same day (the targeted review above), leaving 99 candidates. **93 adopted**
onto `upstream/2026-08-15-batch`, **6 skipped**. The developer's decision was "everything
except Tier C, Pylon branding wins any conflict", so the table below records the two
Pylon-first departures from a mechanical adoption rather than a per-commit list.

This is the largest batch adopted so far and it is overwhelmingly repair: **86 of the 99
candidates are `fix`**. Upstream spent the day merging its backlog of old community pull
requests, which is why so many #4xxx/#5xxx numbers land at once.

Grouped decisions, by area rather than by commit — every candidate not named as skipped
was adopted:

- **Server and orchestration (12)** — bounded thread activity hydration, the wire
  projection for streaming `tool.updated`, the provider title mirror no longer clobbering
  real titles, receipt replay scoped to its own aggregate, snoozed threads settling
  immediately, SQLite `busy_timeout` instead of `SQLITE_BUSY`, surviving a write to a dead
  socket, valid MCP preview results, a raisable discovery probe budget, install scripts in
  npm-global provider updates, long-running git pushes, and files named `HEAD`.
- **Providers (11)** — six Claude fixes (session-scoped "Always allow", pending user-input
  settling on stop, command lifecycle messages ignored, hooks skipped during capability
  probes, repo-local `.agents/skills` discovery, hermetic Windows tests), two Codex, one
  spanning Codex/Cursor/Grok, OpenCode config inheritance, and the Ultracode description.
- **Web (38)** — the global styling refactor, panels, sidebar, theme, markdown, transcript,
  and eight composer fixes.
- **Desktop (7)**, **mobile (5)**, **source control and pull requests (7)**, **SSH (2)**,
  **terminal (2)**, **marketing (1)**, **shared (1)**.

Four Pylon-authored commits close the batch: `70fd3fa2b` rebrands what the batch dragged
in, `46abbcf18` repairs three conflict resolutions, `d50270899` restores the lockfile, and
`998848720` corrects two keep/drop calls.

**The lockfile nearly shipped broken.** Resolving the styling-refactor conflict reverted
`pnpm-lock.yaml` to its `origin/pylon` state, silently undoing what the Windows
update-install pick had added one commit earlier. The branch was then requiring
`msgpackr-extract` and `@electron/asar` without locking either, and recording the _old_
`@ff-labs/fff-node` patch hash against the _new_ patch file — the one that fixes asar
unpacking. `@t3tools/scripts` failed to typecheck and all 53 of its tests failed to load.
Regenerated with Pylon's pinned pnpm in `d50270899`. **Whenever a conflict resolution runs
`git add -A`, check `pnpm-lock.yaml` separately.**

**Watch item for the next batch:** upstream `e58cbb9e7` / `#6663` amends `#6665`, which
this batch adopted, tightening the theme selector to
`html[data-theme-id]:not([data-theme-id=""])`. It sits just past this cursor. No Pylon code
path was found that sets `data-theme-id` to the empty string, so this is drift-closing
rather than a known defect.

| Change set | Upstream                            | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1         | `d7abd7f3b` + `804cba430` / `#6657` | skipped  | `—`             | A feature and its own revert, both inside this range. Verified they cancel exactly (`git diff d7abd7f3b^ 804cba430` is empty), so adopting the pair is 32 conflicting files for a net no-op.                                                                                                                                                                                                                                                        |
| G2         | `e25021af7` / `#4128`               | skipped  | `—`             | AUR packaging: `t3code-bin` / `t3code-nightly-bin` PKGBUILDs pointing at `pingdotgg/t3code` releases, plus a publish workflow needing T3's AUR SSH secrets. Entirely T3 distribution infrastructure. Revisit only as a Pylon-owned `pylon-bin`.                                                                                                                                                                                                     |
| G3         | `e9ae134c5`                         | skipped  | `—`             | Routes feature requests to `pingdotgg/t3code` Discussions. T3 repository governance; Pylon's README and CONTRIBUTING are its own.                                                                                                                                                                                                                                                                                                                   |
| G4         | `2fc676239` / `#3929`               | skipped  | `—`             | Strips a stray newline from the `CLAUDE.md` symlink target. Pylon's symlink is already 9 bytes (`AGENTS.md`, no trailing newline), so this is already true here.                                                                                                                                                                                                                                                                                    |
| G5         | `db3278f97` / `#4542`               | skipped  | `—`             | **Pylon already fixed this.** Upstream lifts the mobile hero's Grok mark clear of the headline by moving it to `top: 44px` centred; Pylon did the same thing independently in `ad1693bb3` at `top: 150px` left-aligned, tuned against Pylon's own resized hero (`b732d74ed`). Taking upstream's coordinates would apply T3's geometry to different artwork. The cherry-pick reduced to empty and was dropped.                                       |
| G6         | `ad117235b` (partial) / `#6201`     | adopted  | `dc7fcfafa`     | DMG installer backgrounds and the production macOS icon pipeline. **Mechanism adopted, artwork rebranded** in `70fd3fa2b`: upstream's SVGs carry a "T3 CODE" wordmark and "Drag T3 Code to Applications". The pipeline itself is correct for Pylon unchanged, because `assets/prod/black-macos-1024.png` is already Pylon artwork despite the compatibility-named file. Upstream's retirement of `apps/desktop/resources/icon.*` was taken with it. |

Two further Pylon-first departures inside adopted commits, both recorded here because a
future reader will otherwise read them as mistakes:

- **`7afa184a9` / `#4781`** ("keep send reachable while a turn is running on mobile").
  Upstream removes its early `if (isRunning) return stopButton` and shows the real send
  button beside stop on mobile viewports. Pylon already solved the same problem
  differently, with a dedicated queue-follow-up button shown on _every_ viewport — but
  gated on `supportsSessionInputQueueFollowUp`, a **provider capability**, so providers
  without a session input queue still had upstream's bug. The two were composed rather
  than chosen between: the running branch now prefers Pylon's queue affordance and falls
  back to upstream's plain send when the provider has no queue. Upstream's stop-button
  sizing condition (`showSendWhileRunning && hasSendableContent`) was taken as-is; it now
  also governs the queue case, so on a mobile viewport with a queue-capable provider and
  an empty composer, stop renders 32px beside a disabled 36px queue button. Pre-existing
  mismatch, narrowed rather than introduced — worth tidying if the row ever looks wrong.
- **`d5465aebf` / `#4755`** ("retain terminal PR badges after checkout switch"). Upstream's
  import of lucide's `TerminalIcon` was taken during conflict resolution and then removed:
  Pylon renders that indicator as `DotMatrix state="terminal"`, not a lucide glyph with
  `animate-status-pulse`, which Pylon's taste rules forbid.

**Verification.** Typecheck clean across all nine packages (`t3`, web, contracts, shared,
client-runtime, mobile, desktop, scripts, marketing). `vp lint` exits 0 with three warnings,
all in upstream-authored code and none in a Pylon resolution. `vp fmt --check` clean over
2,898 files. Tests: web 2,758 in 283 files; client-runtime 658; shared 355; contracts 342;
scripts 53; server orchestration/provider/persistence/vcs/pullRequest/mcp/sourceControl.
`node scripts/export-pylon-brand-icons.mjs --check` reports 39 files current.

Two test notes for whoever runs these next:

- **`apps/server/src/provider/accountDrainEndToEnd.test.ts` hangs for 120s and fails.** It
  fails **identically on a clean `origin/pylon` worktree**, so it is pre-existing and not
  batch fallout. Not investigated further here.
- **`scripts/build-desktop-artifact.test.ts` fails when run from inside Pylon.** The
  cross-architecture probe test asserts no spawned command carries
  `ELECTRON_RUN_AS_NODE=1`, but an Electron host exports that variable and the code under
  test spreads `process.env`. Run it with `env -u ELECTRON_RUN_AS_NODE`; 53/53 pass. CI is
  unaffected.

**No integration pass in a real client.** No browser, desktop, or mobile run — the batch
touches the composer, sidebar, theme, DMG chrome, and the PWA manifest, so a web pass is
the obvious next step.

## 2026-08-16 — `a5e29edeec34fdfab1d44e643b0d12bb924fd261..bab4b6f02b8bdaf15fd32636a97f69ff657cec50`

Ten upstream commits, ten change sets. **Nine adopted** onto `upstream/2026-08-16-batch`,
**one skipped**. A quiet day after the 100-commit sweep: two real features, four small
fixes, two test-hygiene sweeps, one repo-plumbing change. `git cherry` reported all ten
absent from Pylon, so nothing was patch-equivalent.

**N1 closes the watch item** left open at the end of the 2026-08-15 batch. Still no Pylon
code path was found that sets `data-theme-id` to the empty string, so it remains
drift-closing rather than a fix for a live defect.

**N3 is the substantial one.** Mobile gains the built-in theme library and System/Light/Dark
selection, and the canonical palettes move out of `apps/web/src/themePalette.ts` into
`packages/shared/src/themePalettes.ts` + `themePreview.ts` so web and mobile cannot drift.
Upstream deliberately excluded theme import, creation, and editing on mobile. The
`packages/shared/package.json` change is subpath exports only — no dependency change, so
**`pnpm-lock.yaml` is untouched by this batch** (checked explicitly, per the 2026-08-15
lockfile near-miss).

Branding pass on N3, following the F10 precedent that **theme ids are compatibility
identifiers and labels are not**: `MOBILE_DEFAULT_THEME_ID` stays `t3-code` so saved mobile
preferences keep resolving, while its visible label became "Pylon", the new
`docs/user/mobile-appearance.md` was rewritten to Pylon voice, and two doc comments in
`mobileDefaultTheme.ts` and `themePreview.ts` were rebranded. Pre-existing "T3 Code" strings
in `docs/README.md`, `docs/operations/mobile-app-store-screenshots.md`, and
`scripts/mobile-showcase.test.ts` were confirmed present on `origin/pylon` and left alone as
branding debt tracked separately.

Three conflicts, all resolved Pylon-first:

- **`ProviderIcon.tsx`** (N3) — both-sides-add on imports. Kept Pylon's `Circle` and
  `providerIconKind` (the distinct provider marks from B1) and took upstream's
  `useAppearancePreferences`, dropping the now-unused `useColorScheme`.
- **`ThreadComposer.tsx`** (N3) — both-sides-add on imports; both kept.
- **`themePalette.ts`** (N3) — upstream deletes the T3 Chat palettes as they move to the
  shared package, and Pylon had rebranded four comments inside those deleted blocks.
  Resolved by taking upstream's file wholesale, then restoring the **three** Pylon rebrands
  that survive the deletion. Verified `T3_CHAT_LIGHT_COLORS`/`T3_CHAT_DARK_COLORS` have no
  remaining web references.
- **`ProviderRegistry.test.ts`** (N5) — Pylon's own "projects pushed rate-limit state onto
  the instance snapshot" test sits immediately before the test upstream deletes. Kept
  Pylon's, deleted upstream's.

**Verified upstream's claim rather than trusting it** for N5: `mergeProviderSnapshots` and
`selectProvidersByKind` have exactly one hit each outside tests in Pylon — their own
`export` — so the "no production callers" premise holds here too.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | --------------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1         | `e58cbb9e7` / `#6663` | adopted  | `c8eca3857`     | Theme selector tightened to `html[data-theme-id]:not([data-theme-id=""])` for specificity without raw `.dark` selectors. Closes the watch item from the 2026-08-15 batch.                                                                                                                                                                                                                                                                                                               |
| N2         | `2f486ab80` / `#7107` | adopted  | `72cd53a41`     | The Advanced theme editor groups ~60 raw roles into named color families; `updateThemeColorFamily()` derives paired foregrounds only for the family touched, leaving imported palettes otherwise unnormalized.                                                                                                                                                                                                                                                                          |
| N3         | `d23b181da` / `#6619` | adopted  | `4838326f1`     | Mobile built-in themes plus System/Light/Dark, with palettes and preview generation extracted to `packages/shared`. See the branding and conflict notes above. **Not yet verified on a device or simulator.**                                                                                                                                                                                                                                                                           |
| N4         | `d484735c6` / `#7132` | adopted  | `bd922a271`     | A keyboard-highlighted command menu item no longer scrolls to rest under the scroll-fade mask. Reaches every `ScrollArea` using `scrollFade`.                                                                                                                                                                                                                                                                                                                                           |
| N5         | `277322933` / `#6267` | adopted  | `c3ad0b60d`     | Removes 875 lines of duplicate and stale tests across server, web, desktop, mobile, relay, and scripts. Ten of eleven files were byte-identical to upstream; only `ProviderRegistry.test.ts` conflicted.                                                                                                                                                                                                                                                                                |
| N6         | `3583cd27d` / `#7157` | adopted  | `af01aaf9a`     | Drops four test-only exports and the tests asserting on them, moving coverage to public behavior.                                                                                                                                                                                                                                                                                                                                                                                       |
| N7         | `4cb676cc1` / `#7171` | adopted  | `33173950b`     | `CLAUDE.md` becomes a regular file containing `@AGENTS.md` instead of a symlink, because Windows checkouts with `core.symlinks=false` materialize it as a plain file that `vp fmt --check` flags and contributors commit back, corrupting the target. **Tradeoff accepted:** a symlink resolves for any reader, while `@AGENTS.md` only resolves for harnesses that honor @imports. Supersedes G4.                                                                                      |
| N8         | `4c1d99d7f` / `#6392` | adopted  | `8477ddb70`     | Long paths in the commit dialog truncated from the end, hiding the filename. New `StartTruncatedPath` truncates from the start via `dir="rtl"` + `<bdi>`, with the full path in a tooltip.                                                                                                                                                                                                                                                                                              |
| N9         | `89c52a331` / `#6635` | adopted  | `204671979`     | Two `ThreadSettingsSheet` full-screen routes used the `embedded` Android header, which skips the status-bar inset, so their actions sat under the status bar. **Open question:** five other call sites still use `AndroidSheetHeader` (`GitCommitSheet`, `GitOverviewSheet`, `GitConfirmSheet`, `GitBranchesSheet`, `ConnectOnboardingRouteScreen`); their presentation was not checked.                                                                                                |
| N10        | `bab4b6f02` / `#7208` | skipped  | `—`             | Removes the Windows-only silent-install warning from the update confirmation so all platforms share the short copy. Upstream's reason is "install times have improved" — a claim about T3's pipeline, not Pylon's Windows builds. Pylon ships Windows and had already rebranded this copy; the warning describes real behavior (no installer window appears) and without it the app reads as hung. Revisit if Pylon measures its own Windows install times and finds the warning stale. |

### Inherited defects found by review, fixed Pylon-first

An `xhigh` review of the integration branch surfaced three regressions that arrived **with**
the adopted commits rather than from any conflict resolution — `ThemeEditorPanel.tsx` is
byte-identical to `#7107` apart from one rebranded comment, and the mobile files auto-merged.
All are worth reporting upstream.

- **Advanced editor: an Inspect pick could silently no-op.** `selectThemeRole` resolves the
  picked role to its family representative _before_ testing `THEME_EDITOR_SIMPLE_ROLES`, which
  is only `["canvas", "accent"]`. So `chrome`, `toolbar`, `focus`, `update*`, and
  `terminalCursor` all resolve to a "simple" role and skip both `setIsAdvanced(true)` **and**
  `setRoleQuery("")`. Already in Advanced with a filter typed, the role is selected but its
  field stays filtered out of the DOM, so the `scrollIntoView` reveal finds nothing. Fixed by
  clearing the query unconditionally; the query only affects the Advanced list, so clearing it
  on a guided-role pick is inert.
- **Advanced hex fields rewrote themselves mid-keystroke.** `ThemeColorField` fires `onChange`
  per keystroke and `updateThemeColorFamily` canonicalizes to OKLCH whenever the value parses.
  Verified against culori directly: `#ff0` parses as yellow and `#ff00` parses as yellow with
  **alpha 0**, so typing `#ff0000` snapped to `#ffff00` at three characters and the next
  keystroke appended to _that_. Before `#7107` this reached only the two guided roles; it now
  reaches ~22 Advanced families. Fixed by keeping the typed string for the edited role while
  still deriving its family companions — `decodeThemeColors` canonicalizes every role at save,
  which is how Advanced already behaved before this commit.
- **Mobile dark-mode pill contrast** — see the open item below.

Two further findings were confirmed and deliberately **not** fixed: `mergeProviderSnapshots`,
`selectProvidersByKind`, `requireNonNegativeInteger`, and `showcaseSceneUrl` now have zero
callers and zero coverage, because `#6267` deleted their tests and kept the exports. Removing
them is upstream's call to make; deleting them here buys nothing and costs divergence.

The review cleared the parts most at risk: the T3 Chat palette converts to OKLCH with exact
fidelity against the old hex literals, every `useAppearancePreferences` consumer sits inside
its provider, and the `useColorScheme` migration is complete.

**The mobile contrast finding was mostly a false positive — resolved, no change made.** The
review flagged `sidebar-header-actions.tsx`, `sidebar-filter-button.tsx`, and
`ThreadNavigationSidebar.tsx` for swapping a hardcoded idle fill for `--color-glass-surface`,
which in dark mode goes from `rgba(118,118,128,0.24)` (a grey _lift_ above the drawer) to
`rgba(23,23,23,0.78)` (near-black). Checking the call sites settles it:

- `SidebarHeaderActions` and `SidebarFilterButton` each have **exactly one** call site, both
  passing `grouped`. That branch renders `backgroundColor: "transparent"` with `borderWidth: 0`,
  so `idleBackgroundColor` is computed and **never applied**. Two of the three files are dead
  code for this purpose.
- Only `SidebarHeaderButtonGroup`'s `fallbackBackground` is live, and only when
  `isLiquidGlassSupported` is false — Android and iOS < 26.

Confirmed on device: swapping the old literal back in and letting fast refresh apply it produced
**pixel-identical** output on iOS 26.3 — pill fill `rgb(21,21,21)`, background `rgb(10,10,10)`,
contrast 1.084 either way. Changing a design token on arithmetic alone, for a path that cannot
be observed on the platform available here, would be worse than leaving it. **Revisit only with
an Android or iOS < 26 pass**, where the fallback actually renders.

**Verification.** Typecheck clean across web, mobile, shared, `t3`, and desktop — server and
desktop emit only `TS377xxx` _suggestions_, none in files this batch touched. `vp fmt --check`
clean over 96 files. Tests: mobile **790 in 126 files, all passing**; web **2,738 of 2,741 in
280 files**; shared 10; server `ProviderRegistry` 52; scripts `mobile-showcase` 22.

**The three web failures are a local-environment artifact, not batch fallout.**
`apps/web/src/cloud/connectCliAuth.test.ts` assumes `VITE_CLERK_CLI_OAUTH_CLIENT_ID` is unset
unless a test stubs it, and this checkout's `.env` sets `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`, which
`loadRepoEnv` maps into the `VITE_` name. `apps/web/vite.config.ts` then `Object.assign`s that map
into `process.env` at module scope, and Vite exposes every `VITE_` key from `process.env` on
`import.meta.env` — so the test reads the developer's real Connect configuration and the "not
configured" assertions cannot hold. The test and its entire import graph are untouched by this
batch, it fails **in isolation**, and it fails **identically on a clean `origin/pylon`
checkout**, so the deleted test files in N5 did not perturb it by ordering either. CI has no such
`.env` and is unaffected.

> **Correction.** An earlier revision of this entry blamed `define:` in `apps/web/vite.config.ts`,
> reasoning that a textual substitution cannot be reached by `vi.stubEnv`. That is wrong.
> Instrumenting the config showed `mode: "test"` is detected and scoping `define` out of test mode
> left the tests failing exactly as before, which rules it out. The `process.env` assignment above
> is the actual mechanism. Fixed separately on `fix/agent-docs-and-test-isolation` by blanking
> those keys on the web unit-test project.

Two toolchain notes for whoever runs these next:

- **`vp lint` could not run at all in this environment**, on this branch _or_ on untouched
  files: oxlint fails to load `./oxlint-plugin-t3code/index.ts` with
  `ERR_UNKNOWN_FILE_EXTENSION`, under both Node 22.15.1 and Node 24.13.1. This branch touches
  neither the plugin nor the lint config, so it is pre-existing environment breakage — but it
  means **lint coverage for this batch is unproven locally** and CI owns it.
- Running `vitest run scripts/mobile-showcase.test.ts` from the repository root matched the
  same filename inside sibling worktrees under `.prime/worktrees` and reported 5 failed files
  that are not this checkout's. Scope it with `--dir scripts --exclude '**/.prime/**'`. This
  is the same substring-matching trap recorded in the 2026-08-07 batch, with a new directory.

### Integration passes in real clients

**iOS Simulator (iPhone 17 Pro, iOS 26.3), against a copy of `~/.pylon-code` — 4 projects,
25 threads, 593 turns.** No native rebuild was needed: the only new native API is
`getShowcaseTheme`, consumed solely by the screenshot harness through optional chaining, so the
installed dev client was reused.

- Settings → Appearance lists **Pylon**, T3 Chat, Grove, Ocean, Ember, Iris. The default label
  reads **"Pylon"**, confirming the branding pass at both the accessibility layer and on screen.
- Color scheme offers System / Light / Dark. Flipping the simulator to dark with the app on
  **System** repainted the whole sheet, so the system path works.
- Selecting **Ember** repainted the Appearance sheet, thread list, thread-route chrome, and
  primary action buttons; the blue "Working" status label correctly stayed independent of the
  palette.

Not covered on mobile, with the reason: **review sheets, file previews, and the terminal** were
unreachable because thread rows expose no tappable accessibility role (a known limitation the
skill documents) and the thread deep link needs a client-side environment id that is not in the
database. **`#6635` is Android-only** (`Platform.OS === "android"`) and cannot be observed on
iOS at all. The showcase harness's new native path was not exercised, since the old dev client
was reused deliberately.

**Web, via Playwright against system Chrome.** Both fixes in `fe31bc6d7` were proven with a
negative control — the component was reverted to its pre-fix state, re-tested, then restored:

|          | typing `#ff0000` into `#canvas-hex`                          | Inspect pick with `terminal` filter active          |
| -------- | ------------------------------------------------------------ | --------------------------------------------------- |
| pre-fix  | `# → #f → #ff → #ffff00 → #ffff000 → #ffff0000 → #ffff00000` | filter stays `"terminal"`, canvas field count **0** |
| with fix | `# → #f → #ff → #ff0 → #ff00 → #ff000 → #ff0000`             | filter clears to `""`, canvas field count **1**     |

The pre-fix run is worse than predicted: after snapping at `#ff0` it never recovers, ending at
`#ffff00000`. Advanced mode was confirmed to expose 20 hex fields against guided mode's 2.

**N4 (`#7132`) verified live**: the command list carries `not-empty:py-3` computing to
`padding: 12px`, and the scroll viewport reports `scroll-padding: 24px` — both halves of the fix
applied.

**N8 (`#6392`) was not exercised in the live commit dialog.** Reaching it triggered a real
"Generating commit message" agent run, so that path was abandoned rather than driven further; it
also staged the two untracked directories, which was reverted with `git restore --staged`.
Coverage rests on its own unit tests, which assert the `dir="rtl"` + `<bdi>` markup and the
tooltip.

**Fixture note, fixed separately on `fix/agent-docs-and-test-isolation`.** `AGENTS.md`'s "Test
data" section pointed at `~/.t3/userdata`, which for Pylon is the **wrong** database: it is T3
Code's, carrying upstream's migration numbering, and a Pylon server started against a copy of it
dies with `no such column: continued_from_thread_id`. Pylon's own runtime home,
`~/.pylon-code/userdata`, holds the correct 37 Pinned / 38 ContinuedFrom / 39 TurnsKeysetIndex /
40 PinOrderKey sequence. A fresh database built by this branch applied 37–44 cleanly with 36
retired, so the renumbering holds end to end.

## Deferred register

_The register is currently empty. DEF-1 and DEF-2 were adopted on 2026-08-11
(see the sixth batch above); every batch since, through 2026-08-16, deferred
nothing new. Entries are removed once adopted or skipped, so an
empty register means nothing is waiting._

Upstream work that has been reviewed and consciously _not_ adopted yet, with
the condition that should trigger a fresh look. Entries stay here until they
are adopted or skipped outright — a deferral that nobody revisits is the same
as losing it.

Every review must read this register before reporting new candidates,
re-evaluate each `Revisit when` against the current upstream head, and report
the outcome. See Phase 2.5 of the `review-t3-upstream` skill.

| ID  | Upstream | Deferred on | Revisit when | Why deferred |
| --- | -------- | ----------- | ------------ | ------------ |
