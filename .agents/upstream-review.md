---
remote: t3code-upstream
branch: main
reviewed-through: "9b2d04317c68233782e0630464ac86d77d0686f3"
reviewed-through-date: "2026-09-01"
---

# T3 upstream review log

This ledger is the durable handoff between upstream-review sessions. The `reviewed-through` commit is the newest upstream commit for which every candidate has received a user decision. Do not advance it for a partial review.

Deferred decisions remain listed after the cursor advances so later sessions can revisit them without rediscovering the entire upstream range.

Two standing sections outlive any single batch and must be read on every review: the `## Deferred register` holds change sets that were candidates and were consciously not adopted, and the `## Upstream watch list` holds upstream work that never entered a review range at all, so no commit range can surface it.

## Review batches

## 2026-09-02 — scoped adoption, cursor unchanged

**Not a batch review.** The developer asked for upstream's Claude Fable 5.1
support specifically, ahead of any other upstream work, so this session reviewed
exactly one change set out of the 129 commits sitting in
`9b2d04317c68233782e0630464ac86d77d0686f3..57a66608b918d673eeec7e6c94ea5906b756fcd0`.
The other 128 commits were **not** reviewed and have received no decision.

`reviewed-through` therefore stays at `9b2d0431`. A later full review must treat
the whole range as unreviewed apart from the row below, which it should skip as
already adopted.

| ID  | Upstream                                       | Decision | Pylon reference | Notes                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------- | -------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-1 | `c17d02cff` / `#9078` — Claude Fable 5.1 model | adopted  | `#247`          | Clean `cherry-pick -x`, no conflicts, applied line-for-line. Self-contained: it does not depend on `#9084` (remote manifest discovery), which is the large `ClaudeProvider.ts` restructure that follows it upstream and was deliberately left out of scope. |

Two consequences worth carrying forward. The bundled manifest swap promotes
`claude-fable-5-1` into the current Claude set and thereby marks
`claude-fable-5` **legacy** — that is upstream's intent, since 5.1 supersedes 5
in the same tier, but it is a user-visible change to an existing model's status.
And the catalog is gated on Claude Code `v2.1.257`, so the model stays hidden on
older CLIs rather than failing at spawn time.

`#9084` (`03542836`, remote Claude model manifest) is a separate 26-file
restructure that another session had begun stacking on the same branch. It was
split back out and is **not** adopted here; it remains undecided in the
unreviewed range above.

## 2026-09-01 — `1f8ed54add4133ac39effceded8fc1fff12d8e03..9b2d04317c68233782e0630464ac86d77d0686f3`

Twenty-nine upstream commits, reviewed as change sets C-1 through C-21. The
developer directed adopting everything, individually sequenced, accepting manual
conflict work, and explicitly asked that mobile stop being deferred batch after
batch. Every merged set got an adversarial review before merge; each of the four
reviews found real defects, and two found Pylon features that a _clean_ merge had
silently deleted.

**The finding that matters beyond this batch.** Upstream landed `#8793` (12:22),
`#8237` (13:35) and `#8614` (18:08) on 2026-08-30, so each later commit carries
`#8793`'s composer restructure in its tree as context. That restructure was
re-litigated in every cherry-pick until it was split: it is two independent
changes. `ComposerSurface` — animated `borderRadius`, absolute glass layer,
bounded collapsed radius — touches nothing in the toolbar and was **adopted**, so
Pylon's file is now structurally identical to upstream there and those hunks
should stop conflicting. The toolbar row — dropping `ComposerToolbarScroller` for
a fixed flex row — is **declined permanently**. `ComposerToolbarScroller` is
upstream's own component and they still ship it; they stopped using it because
their toolbar holds four controls. Pylon's holds sixteen, because
`ControlPillMenu` does not exist upstream at all.

| ID       | Upstream                                              | Decision                     | Pylon reference                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ----------------------------------------------------- | ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1–C-16 | server, web, desktop sets across the range            | adopted                      | `#205`–`#215`, `#217`–`#219`, merged | Sixteen web/server/desktop PRs. `#216` closed as wrong at the premise. Review fixed real defects in most, including a usage-pricing alias that required unanimity, a `.ts` file misclassified as `video/mp2t`, and an unbounded Electron call that could deadlock a lock.                                                                                                                                                                   |
| C-22     | `#8814` — setup script ordering                       | skipped                      | —                                    | `setupProjectScript` returns the first match, so upstream's second Windows entry can never run. Defect, not a feature.                                                                                                                                                                                                                                                                                                                      |
| C-20     | `f15680bd3` / `#8793` — tool summaries, transitions   | adopted, composer declined   | `#223`, merged `2d168f297`           | Work-log presentation and command labels into `client-runtime`; `commandLabel` genuinely converges with web, `presentation` is mobile-only. Restored six Pylon features the merge silently dropped, including a lying "Working for Xs" pill and invisible tool-call failures. Also fixed four upstream defects with regression tests, and made the vendored `@legendapp/list` scroll-follow defer rather than discard.                      |
| C-21     | `9b2d04317` / `#8862` — Expo glass                    | adopted                      | `#224`, merged `9d82e68ac`           | Consolidates onto the glass library already primary in Pylon. Review predicted a dead scroll-to-end button from a UIKit workaround Expo lacks; tested on iOS 26.3 in both code paths and it does not reproduce.                                                                                                                                                                                                                             |
| C-17     | `86c9a9288` / `#8237` — files in threads              | adopted, manual port         | `#231`, merged `c908bb200`           | 41 of 43 source files applied line-for-line. Review caught that the port's own `onQueueFollowUp` filter was not a queue limitation but silent data loss on an ordinary path — the contract already accepts files, and the draft cleanup deleted the bytes. Filed `#228`, `#229`, `#230` for upstream design issues rather than folding them in.                                                                                             |
| C-18     | `352710d49` / `#8614` — offline voice input           | adopted, manual port         | `#233`, open                         | Dictation controls placed by hand, since upstream places them inside the declined restructure. Review found three ways that stranded the user — unfrozen editor discarding whole transcripts, send vanishing on any dictation error, and Stop unreachable for the entire recording window. All fixed. **Needs a device pass**: `AppleTranscription.isAvailable()` is false on a simulator, so the dictation UI has zero simulator coverage. |
| C-19     | `e3dcc1615` / `#8843` + `f9137a0c8` — attachment menu | approved, not yet integrated | —                                    | Approved in the same direction as the rest of the batch; work not started. Tracked as DEF-10 so advancing the cursor cannot bury it.                                                                                                                                                                                                                                                                                                        |

Two Pylon branding leaks were caught in user-visible copy, both from upstream
text carried verbatim: the iOS microphone permission prompt ("Allow T3 Code to
use your microphone"), which the system dialog renders as-is, and two `T3 Code`
strings in `docs/`. `AGENTS.md`'s animation rule was also reworded (`#227`) after
checking its provenance: the line is inherited verbatim from upstream, upstream
ships code that violates it, and both forks already run several gated continuous
animations.

## 2026-08-29 — `f94a0d646ed78a4788e4af6417f74202a628a5e9..1f8ed54add4133ac39effceded8fc1fff12d8e03`

Forty upstream commits formed twenty-eight change sets, V1 through V28.
`git cherry` found none already patch-equivalent to something on `pylon`.

**The ledger had fallen behind the integration.** An earlier session on
2026-08-29 reviewed the sub-range `f94a0d646..bcb855a63`, integrated thirteen
commits through pull requests `#164`–`#169`, and opened `#170` and `#171` — then
never wrote a batch section and never advanced the cursor. Its decisions survived
only in the pull request bodies. Rows V1 through V7 record them here so the next
review can see them.

The developer then read the brief for the rest of the range and directed that
every remaining candidate be adopted except the three skips and the two
deferrals. Every new branch got an implementer, an independent task review, and a
scoped re-review of whatever a fix round changed; three branches — V15/V16/V17,
V22, and V23 — took one fix round each.

| ID  | Upstream                                                                                                          | Decision                | Pylon reference                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | `a40aef4cc` / `#8226`, `702a6ade3` / `#8605`                                                                      | adopted with adaptation | `#164`, merged `2c748f28d`        | Draft first-send retry; Codex stdin buffering. Resolution dropped the adjacent `AnalyticsService` line Pylon removed when `#7774` landed as plumbing only. Upstream's `#8610` was in that approved set and was dropped in review — re-evaluated as V15.                                                                                                                                                          |
| V2  | `ff1761012` / `#8567`, `0e2905eb7` / `#8435`                                                                      | adopted                 | `#165`, merged `fa24eb048`        | Hidden-preview render lease; OAuth popups from the preview. Plus Pylon fix `1544202a4` (popups no longer inherit the preview guest preload).                                                                                                                                                                                                                                                                     |
| V3  | `94f194816` / `#8351`                                                                                             | adopted with adaptation | `#166`, merged `347ac19f3`        | DPoP failure reasons. Kept "Pylon Connect" wording; one T3 branding leak fixed in `docs/user/remote-access.md`.                                                                                                                                                                                                                                                                                                  |
| V4  | `acb599d2d` / `#8573`, `84b9d9bc2` / `#6011`, `b654911f8` / `#8585`, `ac3b2adf9` / `#8437`, `0009aacdf` / `#8313` | adopted with adaptation | `#167`, merged `7819f23a4`        | `#8313` manually ported around Pylon's task-drawer indicators; `#8585` resolution restored Pylon's ratio benchmark from `a2b1d18ec`.                                                                                                                                                                                                                                                                             |
| V5  | `48c176b3c` / `#5931`, `22c311dde` / `#7313`                                                                      | adopted                 | `#168`, merged `66dbe9de9`        | Searchable project combobox; unpin confirmation (web and desktop only; mobile unpins immediately). Doc conflict resolved without `#8321`'s policy picker.                                                                                                                                                                                                                                                        |
| V6  | `cb49e5d72` / `#8480`                                                                                             | adopted with adaptation | `#169`, merged `972eb6afc`        | OpenCode child approvals, stops, model catalogs; 42 files, eleven conflicts. Resolution gated Pylon's fork-only demand-refresh stream on `refreshOnInterval`, with a regression test. Known gap: seven upstream-amended assertions not carried.                                                                                                                                                                  |
| V7a | `4669eab8e` / `#8607`                                                                                             | adopted                 | `#170`, open                      | iOS header transitions; lockfile regenerated. No simulator build yet.                                                                                                                                                                                                                                                                                                                                            |
| V7b | `3e6ab36f6` / `#8609`, `38dcd7a40` / `#8611`                                                                      | adopted                 | `#171`, open, stacked on `#170`   | Expo SDK 57 and header toolbar hardening. Riskiest set in the range; deliberately isolated so it can be reverted on its own. No simulator, device, or EAS build yet.                                                                                                                                                                                                                                             |
| V8  | `053affbed` / `#8624`                                                                                             | adopted                 | `#171` (third commit `680b0325c`) | Corrects the header approach `#8607` introduced; edits the 4.26.2 screens patch that only exists after `#8609`, so it rides `#171`. Clean pick there.                                                                                                                                                                                                                                                            |
| V9  | `45c0dff8e` / `#8215`                                                                                             | adopted                 | `#185`                            | Android file-screen header actions. Byte-identical.                                                                                                                                                                                                                                                                                                                                                              |
| V10 | `e89800895` / `#8587`                                                                                             | adopted, manual port    | `#185`                            | Command menus on the mobile New task screen. Pylon's own menu logic (disabled-skill filter, native dedupe from `2a099000f`, session commands, `/plan` capability gate) extracted into `use-composer-command-menu.ts`; upstream's cursor-era hook would have regressed it. Review diffed the extraction rule by rule.                                                                                             |
| V11 | `8fc7f2294` / `#8597`                                                                                             | adopted, reduced scope  | `#185`                            | Only `GlassSurface.tsx` (uniwind auto-mapped `glassEffectStyle` into a style array, killing native glass — Pylon had the bug) and three doc lines. The composer and toolbar shadow hunks were already fixed differently in `a23ada2e5` and `8563c0490`.                                                                                                                                                          |
| V12 | `1f8ed54ad` / `#8694`                                                                                             | deferred                | —                                 | Metro and dev-client cost plus product changes (ControlPill long-press needs a 272-line native menu patch; the `client-runtime` registry scope change affects web). Conflicts on scheme identity, the lockfile, and Pylon-owned `AGENTS.md` and skill files. See DEF-8.                                                                                                                                          |
| V13 | `0bbecfabf` / `#8321`, `38154388d` / `#8596`                                                                      | skipped                 | —                                 | Auto-settle opt-in and its exact revert; net zero, and Pylon already matches the post-revert state.                                                                                                                                                                                                                                                                                                              |
| V14 | `ac3a33191` / `#8599`                                                                                             | adopted                 | `#181`                            | Deleted `experiments/messages-glass-lab`. Lockfile churn resolved to Pylon's lock; deletions only.                                                                                                                                                                                                                                                                                                               |
| V15 | `c131f2892` / `#8610`                                                                                             | adopted with adaptation | `#188`                            | Per-turn Claude `getContextUsage` query removed. Taken verbatim it deletes the only producer of `compactsAutomatically` and `autoCompactThreshold`, which gate the "Compacts automatically" note. Pylon queries once per SDK session, caches on the session context, and merges at `emitThreadTokenUsage`; the cache is never cleared on timeout, by design. Review moved the call above `maxTokens` resolution. |
| V16 | `fc262f1a2` / `#8087`                                                                                             | adopted                 | `#188`                            | Thread-title retry: three attempts, 2 s then 4 s, inside the fork. Covers Prime text generation.                                                                                                                                                                                                                                                                                                                 |
| V17 | `ebb9b9fda` / `#8094`                                                                                             | adopted                 | `#188`                            | Edited pull request comments refresh the activity atom, on web and mobile.                                                                                                                                                                                                                                                                                                                                       |
| V18 | `72c44a847` / `#8018`                                                                                             | adopted                 | `#182`                            | Picture-in-picture frames sent only when pixels change; overlay equality short-circuit. This is IPC and decode volume, not websocket volume.                                                                                                                                                                                                                                                                     |
| V19 | `3251b7548`                                                                                                       | skipped                 | —                                 | v0.0.36 version bump. Pylon versions independently.                                                                                                                                                                                                                                                                                                                                                              |
| V20 | `2bc9e8ef6` / `#8603`, `6a9d9f988` / `#8613`                                                                      | skipped                 | —                                 | Macroscope approvability and the VOUCHED roster. Pylon has no Macroscope workflow, and the vouch list is Pylon's own.                                                                                                                                                                                                                                                                                            |
| V21 | `be218ac76` / `#8532`                                                                                             | adopted with adaptation | `#183`                            | Keybindings page rebuilt as settings rows. Upstream's file minus two product strings. No rendering coverage; a visual pass is still owed.                                                                                                                                                                                                                                                                        |
| V22 | `c1c2d5401` / `#8569`                                                                                             | adopted with adaptation | `#187`                            | Environment-published themes and the `t3 theme` CLI. The contract now accepts theme file `version` 1 or 2 — Pylon has exported v2 since `#172`, so upstream's v1-only schema rejected Pylon's own exports. Glossary refs renumbered to `[27]` and `[28]`; nine T3 strings and a `~/.t3` path rewritten. One fix round, which scoped the documented `~/.pylon-code` path to desktop-started servers.              |
| V23 | `5e63aea2d` / `#8504`                                                                                             | adopted, manual port    | `#186`                            | Provider settings cleanup. The panel is byte-identical to upstream; the card was re-implemented on Pylon's, so drain-order chevrons, in-app sign-in, and the redacted email header all survive. Sign in gets its own `inert` fence, and `min-h-19` replaces `h-19`. One fix round added read-only fence coverage, mutation-checked.                                                                              |
| V24 | `074bcd6dc` / `#8627`                                                                                             | adopted                 | `#183`                            | Project picker stays inside the sidebar. Byte-identical.                                                                                                                                                                                                                                                                                                                                                         |
| V25 | `c0e09f323` / `#8501`                                                                                             | adopted                 | `#183`                            | Nested markdown images resolve from the file's own directory. Byte-identical.                                                                                                                                                                                                                                                                                                                                    |
| V26 | `660cddd3b` / `#8090`                                                                                             | adopted with adaptation | `#183`                            | Four composer spacing defects. The segment cap was re-homed to Pylon's `TaskProgressSegments` as `MAX_TASK_PROGRESS_SEGMENTS`, so it also applies to the timeline turn-plan row and the count still renders.                                                                                                                                                                                                     |
| V27 | `bcb855a63` / `#8236`, `d22709f75`                                                                                | adopted with adaptation | `#184`                            | Web file attachments; the server half was already `#8235`, taken as `#140`. Three `ChatComposer.tsx` regions hand-placed; review matched every file's line multiset to upstream. The paperclip is not in Pylon's collapsed-mobile row.                                                                                                                                                                           |
| V28 | `3d32797f6` / `#8693`                                                                                             | deferred                | —                                 | Composer banner and activity unification. Manual port, 13 conflicting files, hard-depends on V27, hours old, and forces decisions on Pylon's `waitingOn`, task dismiss, `workingStepLabel`, and usage-indicator placement. See DEF-9.                                                                                                                                                                            |

**The ledger can fall behind the integration.** Six merged pull requests and two
open ones existed with no batch section and no cursor movement, because the
earlier session skipped Phase 5 of the review skill. Any session that integrates
has to write the batch on the integration branch or immediately after it merges.
A decision that lives only in a pull request body is a decision the next review
cannot find.

**The `t3` CLI and the desktop disagree about the runtime home.**
`resolveBaseDir` in `apps/server/src/os-jank.ts` defaults to `~/.t3` when neither
`--base-dir` nor `T3CODE_HOME` is set, while the desktop resolves
`~/.pylon-code`. `docs/user/environment-theme.md` is the first user doc to depend
on that default, and it now scopes the path to desktop-started servers rather
than asserting a single home. The maintainer decision is still pending: change
the CLI default fork-wide, or keep `~/.t3` as compatibility behaviour. Note that
`docs/user/remote-access.md` still tells users about "the shared `~/.t3`
install".

**`fs.watch` delivers no events on the maintainer's Mac.** Node v22.22.3 on
Darwin 25.5.0, for any directory, sandboxed or not. Upstream's environment-theme
watcher test cannot pass there while being green on Ubuntu CI, and the theme
watcher feature itself will not fire on that machine either. This is not a repo
defect, but it is worth knowing before anyone debugs a watcher there again.

**Nothing in this batch was seen in a client.** Every pull request body lists the
visual or device pass it still owes: `#170`, `#171`, and `#185` need a simulator
build before release, `#183`'s keybindings rewrite has no rendering coverage at
all, and `#186` narrows the providers page.

**Pull request `#169`'s seven-assertion coverage gap is still open.** The
OpenCode adoption did not carry seven assertions upstream had amended, and
nothing later in this batch closed them.

## 2026-08-28 — `e2d4d12a81516b55abbecdc64794971f781cacd8..f94a0d646ed78a4788e4af6417f74202a628a5e9`

Seventeen upstream commits formed thirteen change sets. The developer reviewed the
brief and directed that everything recommended as adopt, consider, or defer be
taken, and only the skips skipped — so nothing in this range remains undecided and
no new register entries were opened. `git cherry` found none already present.
DEF-7 was the only open entry and stayed open.

All thirteen adoptions have merged; the table records each one's merge commit.
Every branch was rebased onto `pylon` first, except the mobile theme refactor,
which took a merge instead: `92ec009ee` had landed in the meantime and replaced
the same status-indicator lines with Pylon's own semantic warning tokens, so
resolving that once in a merge was clearer than replaying it through four
commits.

Two recommendations were revised during review, both after the developer pushed
back on the reasoning rather than the conclusion. U12 had been recommended as
defer; that was wrong in direction. #7327 deletes `useThemeColor` and its uses across 67
files, so upstream is entirely on the far side of the change and deferring would
have taxed every later mobile adoption without ever delivering the benefit — the
real choice was adopt-soon or skip-permanently. U11's deferral rested on the
`~/.t3` path, which is ordinary porting work; the honest objection is that the
tests which execute the generated install script skip silently on macOS for want
of `flock`.

| ID   | Upstream                                     | Decision                | Pylon reference            | Notes                                                                                                                                                                                                                                                                                                                                                         |
| ---- | -------------------------------------------- | ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1a  | `f276e632c` / `#8472`                        | adopted with adaptation | `#130`, merged `77336451a` | Provider settings editor layout stabilised. Follow-up to the split taken in `#125`. Four conflicts resolved Pylon-first.                                                                                                                                                                                                                                      |
| U1b  | `f276e632c` / `#8472`                        | skipped                 | —                          | Upstream's re-added "Account email" field in the Configuration tab. Pylon shows the email in the editor header by the developer's 2026-08-27 decision; both would render the same redacted address twice.                                                                                                                                                     |
| U2   | `94401d01b` / `#8447`                        | adopted                 | `#128`, merged `de82ec82b` | Codex 0.150 account plans. Schema and label halves are coupled by `satisfies never`; verified by mutation probe. Ships extra label and namespace tests upstream lacks.                                                                                                                                                                                        |
| U3   | `2fbe31309` / `#8483`                        | adopted                 | `#127`, merged `0aac3b99e` | Preview automation in agent-created threads. Pylon had the identical 128-character `PreviewTabId` bug on the IPC result. Reviewed clean with no findings.                                                                                                                                                                                                     |
| U4   | `f1e6f0c9b` / `#8395`                        | adopted with adaptation | `#131`, merged `a235bd907` | Ordinary tool failures stop rendering red. Three upstream tests asserted lucide class names Pylon cannot emit — one was vacuous — and were retargeted at Pylon's DotMatrix signals. Mobile warnings also moved to amber.                                                                                                                                      |
| U5a  | `9257bd860` / `#8168`                        | adopted                 | `#133`, merged `fbdd94b66` | Back button on project settings. Reverse-state fix.                                                                                                                                                                                                                                                                                                           |
| U5b  | `7068e86f7` / `#8507`                        | adopted with adaptation | `#134`, merged `92dce5a47` | "Open on GitHub" when the pull request API fails. One docs conflict resolved Pylon-first; upstream's copy named T3 Code twice.                                                                                                                                                                                                                                |
| U5cd | `b0ae3f3a8` / `#8468`, `c8aba2587` / `#8484` | adopted                 | `#135`, merged `9dd3c8e65` | Staged-fmt hook tolerates ignored-only changes; a tautological cache-key test removed.                                                                                                                                                                                                                                                                        |
| U6   | `4c51b4c9b`                                  | adopted                 | `#132`, merged `292366962` | `mod+shift+p` toggles thread pin. Pylon already had the whole substrate.                                                                                                                                                                                                                                                                                      |
| U7   | `b982847ab` / `#8467`                        | adopted, reduced scope  | `#139`, merged `88d232802` | iOS home header stability patch. Originally scoped with `850e4582e` / `#8399`; that commit is contained in U12, which supersedes it, so cherry-picking it separately would have re-applied an older version.                                                                                                                                                  |
| U8   | `49f6241dd` / `#8502`                        | adopted with adaptation | `#136`, merged `68e3560f2` | Codex sub-agent models. Two child-identity conflicts; Pylon's `toolUseId` kept at the call site because it names the live turn, not the child. Both halves mutation-probed.                                                                                                                                                                                   |
| U9   | `88be5631f` / `#8481`                        | skipped                 | —                          | Client platform analytics. Would enrich per-device data flowing into T3's PostHog project, since Pylon still ships upstream's key with telemetry on by default. (An earlier draft of this row also claimed the feature labels connections "T3 Code Web"/"T3 Code Desktop"; that was wrong, Pylon already emits "Pylon Desktop"/"Pylon Web" from platform.ts.) |
| U10  | `8f4913221` / `#8235`                        | adopted with adaptation | `#140`, merged `3ed652022` | File uploads to 50 MiB. Both of Pylon's Prime adapters needed the image-only guard upstream gave its five, or a PDF would have been base64'd as an ACP image block. The daemon adapter was missed until review. Ships tests upstream never wrote.                                                                                                             |
| U11  | `f94a0d646` / `#5769`                        | adopted with adaptation | `#141`, merged `864f7fbf3` | WSL runtime cached inside the distro, remapped to `~/.pylon-code/wsl-runtime`. Not branding: the pruner deletes unrecognised `sha256-*` siblings, so a shared parent means two products deleting each other's runtimes.                                                                                                                                       |
| U12  | `018d7f277` / `#7327`                        | adopted with adaptation | `#138`, merged `eafef85ca` | Mobile semantic themes compiled for Uniwind. Six conflicts; `T3Wordmark` stays deleted and `PylonMark` gains the same idiom. Also converted three Pylon-only files the new lint rule rejected at error severity.                                                                                                                                              |
| U13  | `5766dfbf5`                                  | skipped                 | —                          | Nightly cron minute moved 7 → 38. Applies to Pylon, but upstream states plainly it is a guess at GitHub scheduler behaviour, and Pylon has seen no evidence of skipped nightlies.                                                                                                                                                                             |

**Every change set got an independent review pass, and it mattered.** The first
four were reviewed as they landed; the remaining ten were reviewed afterwards, on
the developer's prompting, after the batch summary overstated coverage. That
second sweep found defects on five of the ten, including two the batch would
otherwise have shipped: the image-only guard was on only one of Pylon's two Prime
adapters, leaving the daemon backend base64'ing PDFs as image blocks, and the
mobile composer lost its shadow colour to a bare Tailwind shadow-colour utility
that emits no `box-shadow`, so iOS fell back to opaque black. Both were Pylon-side
adaptation mistakes, not inherited upstream bugs. Fixes landed on their branches;
findings left open are recorded as pull request comments, because they belong to
the review of a specific change rather than to the decision to adopt it.

Two review findings outlive their pull requests and belong here.
`thread/resume` is sent with `excludeTurns: true`, a parameter that appears
nowhere in the generated Codex schema, so upstream's sub-agent model lookup either
errors into a swallowed `Effect.catch` or silently loads a child's full history.
And `ProviderService.followUp` never builds the attachment path lines `sendTurn`
builds, so once a client can attach a generic file, one attached to a queued
follow-up is dropped with neither native ingestion nor a path — inherited from
upstream, and unreachable only until `#8236`/`#8237` ship.

**Three findings worth carrying forward, none fixed in this batch.**

Pylon reports telemetry into T3 Code's analytics project. `AnalyticsService.ts`
still defaults to upstream's PostHog key `phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m`
and host `us.i.posthog.com` with `T3CODE_TELEMETRY_ENABLED` defaulting to true,
and `git log origin/pylon --not t3code-upstream/main -- apps/server/src/telemetry/`
is empty — the directory has never been touched since the fork. This is why U9
was skipped, and it is a live issue independent of that decision.

Codex decode is a treadmill. `planType` is a closed literal on a required field
and `account/read` is a bare `yield*`, so one unrecognised plan fails the entire
Codex probe — status error, zero models, zero skills — rather than degrading a
single label. Codex auto-updates ahead of Pylon, so U2's shape recurs on every
release that names a plan. The same pattern applies to `CodexErrorInfo`
(0.150 added `misalignmentPolicyViolation`) and to `HookEventName`/`HookHandlerType`,
where decode failures are swallowed at `client.ts:156` and produce a silent hang
instead of an error. Upstream models tolerance in Rust via `#[serde(other)]` but
not in the generated schema.

`schema.gen.ts` cannot be verified by regeneration in either fork. `UPSTREAM_REF`
is pinned to the same ref recorded in the file header, yet regenerating produces
roughly 39k lines of difference because a dependency now emits
`.annotate({ identifier: … })` and orders declarations differently. The
`identifier: "` count is 0 in the committed file, on `origin/pylon`, and on
`t3code-upstream/main` alike, so the staleness is shared and pre-existing — but
that generated file is effectively hand-maintained today.

**One pre-existing failure surfaced.** `scripts/build-desktop-artifact.test.ts`
fails on `pylon` itself: "skips the primary native probe for cross-architecture
Windows payloads". Confirmed by running `origin/pylon`'s own copies of the script
and its test (1 failed / 58 passed), so U11 did not cause it. Either CI does not
run that file or it has been broken unnoticed.

## 2026-08-27 (third batch) — `f6f2be32d8bc072e87753e41ad77c7c67e8b0b95..e2d4d12a81516b55abbecdc64794971f781cacd8`

Two upstream commits formed two change sets. The developer approved both
recommendations as briefed: the Android launcher icon fix as a manual port, and
`#8380` in full — the environment-variable resync fix, the muted disabled dot,
and the master-detail redesign — after choosing to keep the account email in the
editor header rather than dropping it as upstream did. `git cherry` found neither
already present. DEF-7 was the only open register entry and stayed open; this
batch opened none.

Both pull requests have since merged, closing the caveat this entry originally
carried: `#125` as `9514875cc` and `#124` as `2b7a9b8e2`. `#125` merged first, so
the ledger record landed beneath the work it describes.

| ID  | Upstream              | Decision                | Pylon reference     | Notes                                                                                                                                                                                                |
| --- | --------------------- | ----------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | `348367dcc` / `#4332` | adopted with adaptation | `eef9d3531`, `#124` | Android adaptive launcher icon. The bug was live in Pylon on all three channels; upstream's asset is a T3 wordmark, so the fix was ported through Pylon's own exporter instead. See below.           |
| U2  | `e2d4d12a8` / `#8380` | adopted with adaptation | `c5e0f2da1`, `#125` | Provider settings split into a list and an editor, plus an environment-variable resync fix and a muted disabled dot. Nine conflicts resolved Pylon-first; five Pylon features re-grafted. See below. |

**U1 was a live Pylon defect on every channel.** Android scales an adaptive
layer to the full 108dp canvas and shows only its centred 72dp through the
launcher mask, so `apps/mobile/app.config.ts` pointing
`androidAdaptiveForeground` at `developmentUniversalIconPng` and
`nightlyLinuxIconPng` meant full-bleed 1024px channel artwork was zoomed and
edge-cropped; production pointed at `android-icon-mark.png`, whose opaque extent
reaches 154.7px from centre on a 432px canvas against a 132px safe radius. The
same asset feeds the `expo-quick-actions` shortcut icon, so both surfaces were
wrong. Upstream hand-commits a T3 wordmark PNG plus an `rsvg-convert` recipe;
Pylon instead generates `android-icon-foreground.png` from `T3Mark.svg` in
`scripts/export-pylon-brand-icons.mjs`, and the exporter now measures the
composited layer and throws above 132px, so the invariant is enforced rather
than described — `icons:check` only proves the output matches the vector, and it
is not wired into CI. One shared layer across channels, as with the monochrome
mark; the background colour differentiates.

Review of the first commit corrected two things worth recording. The layer sat
_on_ the safe circle rather than inside it (368px → 133.7px counting every
non-transparent pixel, 131.9px only if the antialiased fringe is ignored); it
renders at 352px now, reaching 128.0px. And `androidMonochromeIcon` still
pointed at `android-icon-mark.png`, which Android masks with the same path as
the foreground, so Android 13+ themed icons kept the identical clipping one line
below the fix. Both masked layers use the inset rendition;
`android-icon-mark.png` remains the source for the unmasked notification icon.

**U2 would not have compiled, and would have silently dropped a Pylon feature.**
The new device tab bar calls `connectionPhaseDotClassName` and
`connectionPhasePingClassName`, neither of which exists in Pylon — it replaced
`ConnectionStatusDot` with a DotMatrix-backed component taking a `state`. Beyond
that, upstream deletes `ProviderAuthEmail` and leaves the account email nowhere
on the page, which is free for upstream's one-account-per-driver model and not
for Pylon's several-with-a-drain-order. The developer chose to keep it in the
editor header; `showEditorStatus` was widened from warning/error to any account
with an email or a sign-in to offer. Four more Pylon features were re-grafted
into the new layout: drain-order controls and the account reset into the editor
header beside delete, the usage summary onto every list row rather than only the
selected account, the detailed usage rows to the top of the Configuration tab,
and the sign-in dialog as a sibling of the editor. `ProviderUsageSummary`'s root
became a block `span`, because a `<p>` inside the list row's select button is
invalid DOM. A focused test now pins the drain-order wiring, mutation-checked
both ways. The environment resync fix ships untested: `apps/web` has no DOM test
environment, so the effect it lives in cannot be exercised.

## 2026-08-27 (second batch) — `33b650a5b3b27382b35d2182dec6b22438c3da56..f6f2be32d8bc072e87753e41ad77c7c67e8b0b95`

Eight upstream commits formed eight change sets. The developer approved every
recommendation as briefed: five adoptions and three skips. `git cherry` found
none already present. DEF-7 was the only open register entry and stayed open;
this batch opened none.

| ID  | Upstream              | Decision                | Pylon reference     | Notes                                                                                                                                                                                               |
| --- | --------------------- | ----------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | `f925d6394` / `#8346` | adopted                 | `280e9b57e`, `#117` | Schema generator pins `CollabAgentTool`, `CollabAgentToolCallStatus`, and `SubAgentActivityKind` so generated Codex namespaces accept Codex 0.150 multi-agent events. Clean cherry-pick.            |
| U2  | `d3c24a14b`           | skipped                 | —                   | T3 v0.0.35 release metadata crosses product release boundaries and is superseded by Pylon's release workflow. Same rationale as the 2026-08-26 batch's U5.                                          |
| U3  | `ead4ce52a` / `#8358` | adopted with adaptation | `bbd1267f3`, `#118` | Grok gains skill discovery, a reasoning control, plan mode, a turn liveness watchdog, and usage limits. Four conflicts resolved Pylon-first; Pylon's `acceptAlways` decision re-grafted. See below. |
| U4  | `230c5d4a5` / `#5195` | adopted                 | `801082e38`, `#117` | Stale Codex approval callbacks are normalized instead of failing the turn. Fixed a live Pylon defect — see below.                                                                                   |
| U5  | `64ca3b650` / `#8252` | adopted                 | `c0679cab4`, `#117` | Removes a `GitVcsDriverCore` test that a later case in the same file strictly subsumes. Duplication verified against Pylon rather than taken on upstream's word.                                    |
| U6  | `a6797b3b9` / `#7538` | adopted                 | `faaf1758f`, `#117` | Projection bootstrap replays the whole un-applied backlog instead of one page. Fixed the most serious live Pylon defect in the batch — see below.                                                   |
| U7  | `73f8cfc02` / `#8397` | skipped                 | —                   | Bot-authored deletion of eight test files. A fork keeps inherited tests as insurance; see below.                                                                                                    |
| U8  | `f6f2be32d` / `#8400` | skipped                 | —                   | Bot-authored deletion of seven more test files plus three export narrowings. Same reasoning as U7.                                                                                                  |

**U6 was a live Pylon defect, not a forward port.** `ProjectionPipeline.ts`
called `eventStore.readFromSequence(from)` with no limit, and the implementation
defaults `limit` to `DEFAULT_READ_FROM_SEQUENCE_LIMIT = 1_000`
(`OrchestrationEventStore.ts`). Every projector therefore replayed at most 1,000
un-applied events at startup and then stopped silently — no error, just a read
model that comes up incomplete and stays wrong until new events arrive. Any
environment with a backlog past 1,000 events for one projector hits it: a
projector introduced by migration, a long-running install, a restore. The fix
passes `Number.MAX_SAFE_INTEGER`, which is what `readAll` in the same file
already did. Upstream's new test was confirmed to be real coverage: reverting the
one-line change turns it red.

**U4 was also live.** `CodexSessionRuntime.ts` emits
`Unknown pending Codex approval request: …`, a string
`isUnknownPendingApprovalRequestError` did not match. Its fallback branch was
worse — it compared lowercase needles against un-lowercased `Cause.pretty(cause)`
and so could never match any capitalized detail. A stale Codex approval surfaced
as a hard turn failure rather than being normalized.

**U3 would have silently reverted a Pylon decision.** Pylon's
`ProviderApprovalDecision` union carries `acceptAlways` on top of upstream's four
literals, added when `7c6163c67` landed, and every Pylon adapter treats it as at
least session-wide (`acpPermissionOutcome`). Upstream rewrote
`selectPermissionOptionId` into `selectGrokPermissionOptionId` knowing only the
upstream literals, so two of its new paths skipped `acceptAlways`: the
`allow_once` fallback for Grok builds that omit `allow_always`, and registration
in `sessionApprovedOperations`. The first mattered most — returning `undefined`
reaches the permission handler as outcome `"cancelled"`, so **Always allow**
would have rejected the very call the user approved. Both were re-grafted in a
separate commit so the port itself stays diffable against upstream, with a
focused test.

**U3's blast radius exceeds Grok.** `decideToolCallUpdateEmission` and the tool
output bounding in `AcpRuntimeModel.ts` are shared by Cursor, Grok, and Pylon's
own Prime Agent. Emission now also fires on status change and measures
`content`/`rawOutput` length rather than only `detail`, trading somewhat more
websocket traffic per in-progress tool call for live command output that
previously stalled until the call completed. Cursor and Prime Agent suites were
run for that reason. Pylon's own divergence in `AcpSessionRuntime.ts` — the
`extendEnv`, optional `authMethodId`, `shouldDiscardSessionUpdate`, and
`observeSessionUpdate` hooks that Prime Agent needs — sits in different regions
of the file and auto-merged.

**U3's branding conflicts.** `UsageService.ts`,
`packages/contracts/src/usage.ts`, and `docs/user/install.md` each took
upstream's substance (Grok transcript paths, the new Reasoning paragraph) in
Pylon voice. `docs/user/permission-modes.md` auto-merged with Pylon's Prime Agent
section intact. Seven further T3 references in comments and test names were
rewritten. The `t3-*` ACP `clientInfo` identifiers were deliberately left alone:
they are Pylon's established compatibility names across Cursor, Grok, and text
generation, and AGENTS.md keeps compatibility identifiers out of branding work.

**U7 and U8 are skipped because a fork cannot prune tests as freely as upstream
can.** All fifteen files exist in Pylon byte-identical, so both would have picked
cleanly; the question was judgment, not mechanics. Upstream owns both sides of
every contract it tests and can drop a thin test knowing it will notice the
breakage elsewhere. Pylon's inherited suite is precisely what tells a
Pylon-side change that it broke a shared invariant. Three deletions land on
ground Pylon owns deliberately: `mobileBranding.test.ts` pins the
`development→Dev`, `preview→Nightly`, `production→Alpha` stage labels that mirror
the `Pylon (Alpha)` / `Pylon (Nightly)` desktop identity; `themePreview.test.ts`
asserts desktop preview geometry is stable _across clients_; and
`threadSidebarWidth.test.ts` would go away whole — along with the
`THREAD_SIDEBAR_DEFAULT_WIDTH` export — even though five of its six cases are
real clamp and viewport logic rather than trivia. The cost of keeping all fifteen
is roughly 350 lines and negligible runtime. A narrower subset of eight genuinely
thin files was offered and not taken.

`#117` merged as `e336f7e59` and `#118` as `78e58e848`. U3's Pylon-only
`acceptAlways` graft is the separate commit `f8cd01e15` on `#118`.

Validation:

- U1/U4/U5/U6 (`#117`): 74 focused tests across `ProjectionPipeline`,
  `ProviderCommandReactor`, and the generated Codex schema; 56 `GitVcsDriverCore`
  tests after U5's deletion; `t3` and `effect-codex-app-server` typechecks pass
  with 2/2 tasks actually run. U6's coverage was verified by reverting the fix and
  watching the new test fail.
- U3 (`#118`): 86 Grok/skills/ACP-support/xAI tests pass with 5 opt-in real-CLI
  skips; 104 shared-ACP, Cursor-probe, and usage tests pass with 3 skips; 250
  Prime Agent daemon and Cursor adapter tests pass; typechecks pass for `t3`,
  `@t3tools/web`, `@t3tools/contracts`, `@t3tools/shared` (4/4 tasks run) and
  `@t3tools/mobile` (0 errors); lint clean across all 31 changed files.
- Not run: upstream's opt-in real-Grok CLI verification, which needs xAI
  credentials. U3's turn watchdog and rate-limit mapping rest on tests and the
  mock ACP agent, not a live Grok session.

## 2026-08-27 — `860caaa6023a3aaf616a5899816c74c195ca8de2..33b650a5b3b27382b35d2182dec6b22438c3da56`

Four upstream commits formed four change sets. The developer approved all four,
overriding a recommended partial adoption on U3 (see below). `git cherry` found
none already present. The deferred register was empty going in and remains
empty.

| ID  | Upstream              | Decision                | Pylon reference                         | Notes                                                                                                                                                                                       |
| --- | --------------------- | ----------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | `b0a028126` / `#8248` | adopted                 | `edd644865`, `#108`                     | Drops the pinned Clerk UI canary so desktop sign-in tracks stable `@clerk/ui@1` and receives the 1.30.7 OAuth transfer fixes. Clean cherry-pick.                                            |
| U2  | `3b86ef941` / `#8231` | adopted with adaptation | `489fcdf99`, `#109`                     | `unsettledAt` re-entry stamp re-anchors the active-list sort, so an un-settled thread returns to the top. Upstream's migration `043` lands as Pylon's **`047`**.                            |
| U3  | `a3a8cbd60` / `#8250` | adopted with adaptation | `5d8128446`, `#110`                     | Release CI: drops a duplicate web build, starts two jobs alongside preflight, moves the nightly cron off minute zero, and flips nightly concurrency from cancel to queue. Manual port.      |
| U4  | `33b650a5b` / `#8243` | adopted, then reverted  | `6b1f96215`, `#111`; reverted by `#113` | macOS preview DMGs publish to a rolling `desktop-preview` prerelease so headless machines can download without signing in. Reverted the same day on cost/benefit, not on defect. See DEF-7. |

**U2 renumbered its migration.** Pylon retired id 36 and renumbered 037–040, and
already holds `043_ProjectionThreadSessionLifecycle` through
`046_ProjectionThreadLinkedPullRequest`, so upstream's
`043_ProjectionThreadsUnsettledAt` became `047`. Reusing 43 would let
environments that already recorded the session-lifecycle migration silently skip
the `unsettled_at` column. `Migrations.ts` was the only conflict in the whole
change set. U2 also inherits upstream's known limit: threads that settle
_automatically_ — inactivity window, merged pull request — still return to their
old position, because auto-settle is derived on the client and the server has no
event to stamp.

**U3's concurrency half was first recommended for skip, then adopted.** The
initial brief proposed taking three of the four pieces and leaving Pylon's
`cancel-in-progress: ${{ github.event_name == 'schedule' }}` alone, on the
grounds that `8dd0d6e06` set it deliberately after a Blacksmith capacity outage
let 23 nightlies stack ~480 VM-hours deep. The developer questioned the carve-out
and was right to: `124630c3f` moved every workflow onto GitHub-hosted runners on
2026-08-26, so that queue can no longer form, and the concurrency block and its
comment were never revisited. Cancelling is now the more dangerous half —
`publish_cli` pushes to npm before `release` creates the GitHub release, so a
cancel in that window strands a published CLI version with no matching desktop
build, and npm will not reissue that version number. The block now uses
upstream's `cancel-in-progress: false` plus `queue: max`, which are not
separable (the combination with `cancel-in-progress: true` is a workflow
validation error). The comment was rewritten rather than transplanted so Pylon's
incident history and the runner migration stay recorded. Stable releases now
serialize instead of running in parallel; `queue: max` keeps the 100 FIFO
pending slots that make the original "never drop a real release" concern safe.

**U4 was reverted the same day (`#113`).** The `preview:mac` label was created,
and then the feature was weighed properly and undone. Nothing was wrong with the
port; the premise does not hold for Pylon. Fork PRs are excluded by
`head.repo.full_name == github.repository` on both the build and cleanup jobs,
so external contributors — the people a login-free download most helps — cannot
trigger it at all. `gh run download <run-id>` already retrieves artifacts
headlessly with an authenticated CLI, which covers upstream's stated motivation,
and Pylon Nightly already publishes builds every three hours for anything
merged. That leaves one beneficiary: a maintainer testing an unmerged same-repo
branch on a machine where a browser login is inconvenient. Against that sat 210
lines of concurrency-sensitive YAML in which the pre-merge review found four
silent-failure paths, a new `contents: write` token on a PR-triggered workflow,
an unsigned binary hosted publicly under the org's name, and a Releases widget
advertising it as the repository's only release. Unexercised machinery carrying
a write token rots, so it was removed rather than left inert. Recorded as DEF-7
rather than skipped outright, because the premise could change.

**U4's original adoption note, kept for context.** `pylon-code/pylon` had no `preview:mac`
label, so every run of this workflow to date has been `skipped` — before and
after this change. The auto-updater is unaffected: Pylon publishes desktop
releases and the update feed to `pylon-code/pylon-releases`, while the rolling
`desktop-preview` prerelease lands on `pylon-code/pylon`, which has zero
releases, so the nightly channel's `allowPrerelease: true` never sees it.
`release.yml` matches only `v*.*.*`, so the tag does not collide.

Validation:

- U1: `@t3tools/web` typecheck, lint and format on the changed file, 30 focused
  Clerk/passkey/redirect tests. The version resolution was checked against the
  installed `@clerk/shared` 4.30.1 resolver rather than assumed: with the pin
  removed it requests `@clerk/ui@1`, with the old pin
  `@clerk/ui@1.30.5-canary.v20260819050620`. Packaged desktop sign-in is **not**
  covered — upstream merged it untested too.
- U2: 74 focused server tests (projector, decider, projection pipeline, snapshot
  query, projection repositories) and 155 focused client tests (`Sidebar.logic`,
  mobile `threadListV2`). Typecheck passes for server, contracts,
  client-runtime, web, and mobile. Migration manifest verified: 46 entries, no
  duplicate ids, strictly increasing, ending at `47_ProjectionThreadsUnsettledAt`.
  The repository test exercises the real column, since `SqlitePersistenceMemory`
  runs `runMigrations()`. No browser pass; computer use was not requested.
- U3: the duplicate-build removal was verified by running it —
  `vp run --filter t3 build` runs exactly two tasks (web, then server) and still
  produces `dist/bin.mjs`, `dist/service-launcher.mjs`, and
  `dist/client/index.html`. `actionlint` 1.7.12 reports 4 findings on `pylon` and
  5 on the branch; the one new finding is `unexpected key "queue"`, whose schema
  predates GitHub's May 2026 feature. No Pylon workflow runs `actionlint` in CI.
- U4: `actionlint` clean on both `pylon` and the branch. End-to-end behavior is
  unprovable until the `preview:mac` label exists.
- CI results are recorded on `#108`–`#111`.

Adversarial review before merge:

The developer asked for an adversarial pass on all four before anything landed.
It found nine issues across three change sets; seven were fixed on their
branches, two were examined and consciously declined. None of the confirmed
defects were introduced by the Pylon adaptation — U3's and U4's came from
upstream, and U2's were gaps in the seams the renumber created.

- **U3 `8d1739684`.** Upstream's concurrency group collapses every tag push and
  manual stable dispatch into one shared `release-stable` lane. Upstream had no
  concurrency block at all before `#8250`, so for them that was serialization
  from zero; Pylon has keyed stable runs off `run_id` since `8dd0d6e06` so they
  never interact. With `cancel-in-progress: false`, the shared lane would queue
  a P0 hotfix tag behind an in-flight release for its whole build matrix. Pylon
  keeps `run_id` for stable and the shared group for nightlies only, which
  preserves both properties. `check_changes` was also the only job in the file
  without `timeout-minutes`; harmless while a fresh nightly cancelled a wedged
  predecessor, not once nightlies queue. Declined: `relay_public_config` and
  `build_wsl_node_pty` no longer skip on a failed preflight, which costs a
  doomed run up to 30 minutes. That is the price of the parallelism and upstream
  accepted it; `production` has `protection_rules: []`, so there is no approval
  gate or secret exposure.
- **U4 `9d112329e`.** Four ways to leave a wrong final state behind a green
  check, all from one root cause: `set -e` does not fire for a command
  substitution inside `[[ ]]`, so `preview_eligible` read a transient 502 as "PR
  closed". Publish then silently skipped a 25-minute build, or deleted the asset
  it had just uploaded while the PR was open and labeled; cleanup fell the other
  way and deleted a live download. Cleanup also set `removed=true` before
  touching the release, could not tell a missing release from a broken API, and
  swallowed delete errors — a 502 left a public DMG downloadable forever while
  the comment claimed it was gone, the one-way door `AGENTS.md` calls a bug.
  Publish deleted before uploading despite sitting in the cancellable build
  group. Unlabel-then-close could cancel the queued cleanup and leave a `closed`
  run whose `if` required the label that had just been removed, stranding the
  DMG. The PR-controlled DMG name is now pinned to a plain filename, which also
  closes a Markdown link escape in the bot comment.
- **U2 `7f80f5961`.** `047` was the only migration in the 042-046 run without a
  sibling test, which is the guard this repo uses for exactly the failure a
  hand-applied renumber creates: a colliding id makes `Migrator` skip the file,
  the column never lands, and every thread read throws `no such column:
unsettled_at`. `mergeEnvironmentThread` takes the shell as authoritative for
  thread lifecycle but was not given `unsettledAt` alongside the six fields it
  already copies, so a cached detail merged with a fresher shell produced an
  active override with no stamp. Declined: a client-auto-settled thread that
  wakes on activity still gets no stamp (upstream's documented limit, and
  `docs/user/thread-sidebar.md` does not overstate it), and wake-from-snooze
  orders differently from un-settle (a real asymmetry, but a snooze product
  decision rather than part of this port).

U1 was reviewed inline and is clean, with one residual risk recorded rather
than fixed: `@clerk/electron` is exact-pinned in the catalog, but `@clerk/ui` is
not a dependency at all — it is fetched from Clerk's CDN as `@clerk/ui@1`, so
desktop now floats across every future 1.x with no lockfile entry to bisect.

The deferred register was empty at the start of this review, so Phase 2.5 had
nothing to re-evaluate. This batch opened one entry, DEF-7, for the reverted U4.

## 2026-08-26 — `e67074f80933a27bd3cdc4e24f486358407690fb..860caaa6023a3aaf616a5899816c74c195ca8de2`

Five upstream commits formed five change sets. The developer approved the recommended U1–U4 adoptions and U5 skip. `git cherry` found none already present. The deferred register was empty going in and remains empty.

| ID  | Upstream              | Decision                | Pylon reference    | Notes                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------- | ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| U1  | `082e6ea52` / `#7140` | adopted with adaptation | `4f3c6d67c`, `#92` | File chips reveal through Finder, File Explorer, or Linux Files and route through the explicit owning environment. Pylon hides native actions remotely, bounds and force-kills Linux handler probes, avoids per-message storage listeners, adds keyboard-accessible hosted menus, and preserves Windows separator style. |
| U2  | `994372ba4` / `#8228` | adopted                 | `bd6953d80`, `#88` | Feature-branch pushes now target the branch itself instead of writing its commits into the tracked base branch.                                                                                                                                                                                                          |
| U3  | `504177797` / `#8240` | adopted                 | `bf6dae2ae`, `#89` | `@clerk/electron` 0.0.37 prevents destructive virtual-router navigation during multi-step desktop authentication. Shared web/mobile Clerk compatibility remained green.                                                                                                                                                  |
| U4  | `badae6a5c` / `#8227` | adopted with adaptation | `aa67226fc`, `#93` | Codex and Claude legacy classification refreshes from the Pylon-owned public `pylon-code/pylon-releases` manifest, never from T3. The bounded, strict publisher exposes no private source metadata; offline fallback, atomic cache retention, update-check opt-out, and Pylon Claude usage probes are preserved.         |
| U5  | `860caaa60`           | skipped                 | —                  | T3 v0.0.34 release metadata crosses product release boundaries and is superseded by Pylon's release workflow.                                                                                                                                                                                                            |

Pylon-first reconciliation was required for U1 and U4. U1 kept Pylon's environment contracts and remote policy while adding explicit-environment routing across chat and pull-request markdown. Its independent server and web reviews found and fixed a Linux probe that could outlive its timeout, unbounded probe output, false editor affordances, per-message storage subscriptions, fallback-menu keyboard access, and mixed Windows separators. The integrated web client showed the new **Reveal in Finder** item and invoked it through the real websocket route without an error.

U4 keeps the public control plane outside the private source repository. Public seed PR `pylon-code/pylon-releases#1` is merged, the raw endpoint serves the bundled version 1 data, and public `main` rejects force pushes and deletion including for administrators. Independent core and publication reviews found and fixed a settings opt-out fail-open, unbounded remote data, non-atomic cache replacement, potential metadata leakage, mutable write-capable action tags, branch-selectable dispatch, and normalized-size mismatch. The publisher uses a generic public commit message and constructs an allowlisted object rather than copying private source fields.

Validation:

- U1: 160 focused launcher/websocket tests and 58 focused markdown/menu/path tests pass, with one platform skip; server, web, contracts, client-runtime, and mobile typechecks pass; production web build and `vp check` over 27 files pass.
- U2: all 57 focused source-control tests, server typecheck, formatting, and lint pass.
- U3: 30 focused authentication tests, desktop/web/mobile typechecks, frozen install, production web build, and formatting pass.
- U4: 75 manifest/Codex/Claude/provider-registry tests pass; server typecheck, actionlint, and `vp check` over 18 files pass. The real public endpoint decodes to the bundled JSON. Local workflow probes accept the source, reject extra metadata, and reject a compact input whose normalized public output would exceed the runtime byte cap.
- Required CI completed green on U2 and U3 before merge and on U1 before merge. U4 CI is recorded on `#93`.

## 2026-08-25 — `bd9ed2b4bbda3dd6e468df1cb06233e29c4a9f5c..e67074f80933a27bd3cdc4e24f486358407690fb`

Twelve upstream commits grouped into ten change sets. The developer approved the full batch with an
explicit instruction to adapt rather than transplant. `git cherry` found none of them already
present. The deferred register was empty going in and remains empty.

Three change sets needed Pylon-first reconciliation.

**B1 dropped its analytics half.** `#8169` extends the `client.connected` PostHog event with device
model and OS major version. Pylon deleted that event, and the two beside it, in CS-12 of the
2026-08-21 batch (`#7774`, `848d5e0c2`) because `AnalyticsService` still defaults
`T3CODE_POSTHOG_KEY` to **T3's** project key — adopting this as written would have reported every
Pylon user's device model into T3's analytics. The presentation metadata was kept, since Settings →
Connections already renders device type and OS per session. The `clientOs`, `clientOsMajorVersion`,
and `clientDeviceModel` websocket URL parameters went with the event: their only consumer was
`readMobileDeviceAnalyticsProps`. `server.test.ts` keeps Pylon's replacement assertion. The mobile
label stays "Pylon Mobile".

**B6 met a compaction UI Pylon already had.** `#8144` adds a resume-compaction prompt plus an
`onCompact` button trio on `ContextWindowMeter`. Pylon's meter already owns
`ContextCompactionControls` and `HarnessRefinementControls`, so the button trio and the composer
footer block that rendered it were dropped rather than shipped as a second control for one action;
upstream's footer is also a region Pylon had restructured, so taking it would have rendered a
duplicate. Upstream's popover `closeDelay` change was kept but rewired onto Pylon's control props,
with a test pinning both states. `autoCompactThreshold` derivation went to
`packages/client-runtime/src/state/contextWindow.ts`, where `#7150` moved the deriver, using
Pylon's `asNonNegativeFiniteNumber`. ChatView derives the snapshot once for both the banner and the
handoff offer instead of upstream's second identical memo, and the composer keeps deriving its own,
so only `compactDisabled`/`compactDisabledReason` cross that boundary. The feature itself — the
adapter's question, the shared copy module, and the banner — landed intact.

**B4 and B5 are one decision.** `#8175` flips Cursor to off-by-default; `#8176` is the migration
that re-enables cursor, grok, and opencode instances the user has actually run. Adopting `#8175`
alone would silently disable Cursor for existing users. Pylon's `primeAgent` defaults to enabled
and is untouched by the migration's three-driver list, which is correct — it was never flipped off.

| ID  | Upstream            | Decision                  | Pylon reference | Notes                                                                                                                          |
| --- | ------------------- | ------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| B1  | `#8169` `bce680926` | adopted (with adaptation) | `3e3a29750`     | Mobile device model and OS major version. **Analytics half dropped** — see above.                                              |
| B2  | `#7279` `afc834280` | adopted                   | `af7b14dbb`     | Bounds cumulative tool-output growth in the ACP runtime, which Pylon uses for Cursor, Grok, and Prime Agent. Clean.            |
| B3  | `#8172` `e6d487e4f` | adopted                   | `ca7b7ceff`     | Thread shortcut hints wait 200 ms before appearing. Clean.                                                                     |
| B4  | `#8175` `43f723f80` | adopted                   | `bf0af7111`     | Cursor is off by default, opt-in from Settings. Pairs with B5.                                                                 |
| B5  | `#8176` `06de9e90a` | adopted                   | `49d5bd033`     | Re-enables optional providers already in use, so B4 cannot disable a working Cursor. Pairs with B4.                            |
| B6  | `#8144` `c7222ca4d` | adopted (with adaptation) | `8e1cea5a0`     | Claude resume-compaction prompt. **Meter button trio dropped; Pylon's controls kept** — see above.                             |
| B7  | `#8117` `589a9d0e2` | adopted                   | `772a67d46`     | client-runtime retries queries after a connection interruption. Matters for Pylon's remote and relay modes. Clean.             |
| B8  | `#8173` `1baf99195` | adopted                   | `5950f780a`     | Keeps provider CLIs on PATH in the macOS background service. Clean.                                                            |
| B9  | `#8182` `c6b8bb825` | adopted                   | `9e6067000`     | macOS desktop preview builds from a `preview:mac` PR label. Generic: globs `release/*.dmg`, so it picks up Pylon's own naming. |
| B10 | `#8177` `1a4a7596c` | adopted                   | `cf3fc451a`     | Release runbook covers verifying remote updates that carry migrations. Maintainer doc; `npx t3` left as a compatibility name.  |
| B11 | —                   | reconciliation            | `10e7ffef5`     | Mobile's own snapshot fixture needed `autoCompactThreshold`; the model.test.ts conflict boundary left a describe block open.   |

**B9 needs a repository label to fire.** The workflow is gated on `preview:mac`. Creating that
label is the only step between this batch and a working macOS preview build.

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

## 2026-08-18 — `bab4b6f02b8bdaf15fd32636a97f69ff657cec50..82b8a9380298509d68170961d9717be62836e490`

Eleven upstream commits, eleven change sets, one PR each. **All eleven adopted** onto
`upstream/2026-08-18-batch`. `git cherry` reported every one absent from Pylon, so nothing
was patch-equivalent. The deferred register was empty going in and stays empty.

**N1 (`#6466`) is the most valuable change here and applied without a single conflict.**
One GitHub pull request detail load was spending 104 GraphQL points: it asked for 100
replies per review thread, followed every reply cursor, and refreshed every minute. The
commit adds an Effect cooldown service keyed by provider **plus host**, native rate-limit
detection for GitHub, GitLab, Bitbucket, and Azure DevOps, a GitHub GraphQL cost budget
that reserves the last 10% for interactive actions, and 10-reply pagination behind a **Load
more comments** button. Upstream measured 104 → 14 points on a 44-thread pull request.
Pylon shipped the multi-provider pull requests page in `9a886cc9d`, so this is quota
protection for a surface users already have. **Three behavior changes ride along and were
accepted deliberately:** long threads paginate instead of loading eagerly, live refresh
slows from 1 minute to 5, and the idle cutoff moves from 5 minutes to 6.

**N3 (`#7209`) carried the only real integration cost.** It adds a
`t3code/no-native-title-tooltip` oxlint rule at **error** severity and migrates 33 native
`title` tooltips to `Tooltip`/`TooltipTrigger`/`TooltipPopup`. Because the rule lands at
error, upstream's migration is not sufficient on its own — the rule also fires on
Pylon-only surfaces upstream cannot see. Running it found **four sites in one Pylon-only
file**, `ProviderUsageMatrix.tsx`, fixed in `18fbcc8d5`. Three became styled tooltips; the
row-label cell carries `whitespace-nowrap` **without** truncation, so its `title` only
repeated text already fully visible, and it was dropped rather than converted. Predicting
the violation set by grep was unreliable — a naive scan over-reported by flagging type
annotations (`<void>`, `<typeof>`) and `title` props on custom components. Running the rule
is the only trustworthy count.

**N5 (`#7083`) is stacked on N4 (`#7082`)** and its three conflicts against `origin/pylon`
all evaporated once N4 was applied first: they were only ever "this file does not exist
yet". Applying strictly in upstream chronological order also made N6 (`#7077`) clean, which
conflicts on two files when probed on its own because N3 rewrites them first.

Conflicts and adaptations, all resolved Pylon-first:

- **`ServerUpdateAction.tsx`** (N3) — upstream replaced the same span with a plain
  destructive dot. Kept Pylon's `<DotMatrix state="error">`, took the tooltip wrapper.
- **`Sidebar.tsx`** (N3) — the "Dismiss Woke notification" pill. Upstream's version carries
  `text-amber-700 dark:text-amber-300`; Pylon's themed `text-warning` token stays. Only the
  tooltip was adopted. Verified no amber/warning drift landed elsewhere in the file.
- **`BrowserDeviceToolbar.tsx`** (N3) — Pylon's aspect-ratio lock button from `#6509`.
  Upstream's `cn(aspectRatio !== null && …)` guards are constant inside each ternary branch,
  so they say exactly what Pylon's direct classes say; Pylon's plainer form was kept.
- **`SettingsPanels.logic.test.ts`** (N4) — both sides append `describe` blocks at the file
  tail, so the merge misaligned the closing braces. Both blocks kept.
- **`CodexSessionRuntime.test.ts`** (N5) — branding. Upstream turned the
  `CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS` constant into
  `codexDefaultModeDeveloperInstructions(hasBrowserTools)`. Took the function, kept Pylon's
  `/Pylon/` assertion.

**Two Pylon-first fixes beyond conflict resolution** (`979d9558c`):

1. `#7083` added `NodeAssert.doesNotMatch(instructions, /T3 Code collaborative browser/)`.
   Pylon renamed that heading to "Pylon collaborative browser" long ago, so the assertion
   passed **vacuously** — it proved the absence of a string that is never present on any
   code path. Repointed at Pylon's actual heading, where it now has teeth. Note the sibling
   `/t3-code/` assertion is correct as-is: that is the MCP **server name**, a compatibility
   identifier, not product copy.
2. The new `IntegrationsSettings.tsx` module comment named T3 Code. Rebranded.

`routeTree.gen.ts` is generated, so its diff was checked rather than trusted: the route
imports in the merged file match the route files on disk exactly, `settings.integrations`
included. `pnpm-lock.yaml` is untouched by this batch — no change set adds a dependency.

| Change set | Upstream              | Decision | Pylon reference | Rationale or revisit condition                                                                                                                                                                                                                                                                |
| ---------- | --------------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1         | `ba46f922a` / `#6466` | adopted  | `08c8b390d`     | Shared per-provider/host rate-limit cooldown, GitHub GraphQL cost budget reserving the final 10% for user actions, and paginated review-thread replies. 104 → 14 GraphQL points on a 44-thread PR. Clean cherry-pick across 41 files. Contract change: new `pullRequests.threadComments` RPC. |
| N2         | `82b8a9380` / `#7172` | adopted  | `5f5efc3fa`     | A late `task.progress` carrying no `status` was re-adding an already-idle task to the live set, leaving the sidebar on **Working** with zero live agents. Status-free progress can now refresh a live task but never resurrect a dead one.                                                    |
| N3         | `fee10def1` / `#7209` | adopted  | `3dde64f61`     | New `no-native-title-tooltip` oxlint rule at error severity plus the migration of 33 sites. Three Pylon conflicts above; four Pylon-only violations fixed separately in `18fbcc8d5`.                                                                                                          |
| N4         | `949feb61e` / `#7082` | adopted  | `0e3fd4617`     | New **Settings → Integrations** page: default preview viewport, zoom, appearance, and floating-preview auto-show. Renders disabled on web clients because these are desktop-local Chromium preferences — the correct multi-surface call, made upstream.                                       |
| N5         | `cd096b9ad` / `#7083` | adopted  | `cf36558bd`     | **Agent browser access** toggle, on by default. Withholds the MCP credential in `prepareMcpSession`, the single place one is minted, so one branch covers all five providers. Takes effect on new sessions only; a running agent keeps its credential for up to 24h.                          |
| N6         | `c7e6d711d` / `#7077` | adopted  | `9f208cab3`     | A review verdict becomes a first-class timeline row with the reviewer's avatar instead of a grey lowercase word inside a collapsed comments group, and the empty markdown block beneath an approval is gone. `COMMENTED`-only reviews still group as conversation.                            |
| N7         | `cebac353d` / `#7321` | adopted  | `03579737e`     | Mobile rendered structured-input options as label-only chips while web and desktop showed descriptions the contract already carried. Closes a multi-surface gap.                                                                                                                              |
| N8         | `33a8b07dd` / `#7276` | adopted  | `a6b9659a0`     | `SymbolView` does not redraw when only the SF Symbol name changes, so the Snoozed and Settled shelf chevrons froze at first render pointing opposite directions. Now one `chevron.down` plus a state-driven 180° transform. No continuous animation.                                          |
| N9         | `a4cc1367b` / `#7219` | adopted  | `c9815194a`     | The usage breakdown table was `.slice(0, 8)` over a window that can hold 90 periods, with nothing on screen saying so. Cap removed, newest first.                                                                                                                                             |
| N10        | `13458e651` / `#7296` | adopted  | `05c123968`     | One `mx-0!` class centering the context usage meter's SVG.                                                                                                                                                                                                                                    |
| N11        | `3723722f7` / `#7364` | adopted  | `1d1851a91`     | Bot cleanup removing a second `expect(only()).toBe(true)`. Verified genuinely redundant — `claimWorkspaceBasenameLookup` returns a pure comparison, so the repeat asserts nothing new. Adopted only to keep the file aligned with upstream and conflict-free later.                           |

### Inherited defects found by review, fixed in a follow-up

> **Closed.** Both were fixed on `fix/pull-request-quota-followups` the same day,
> with regression tests that were checked against the unfixed code first. DEF-3
> and DEF-4 have been retired from the register. The account below is kept
> because it explains why the batch shipped without them.

An `xhigh` review of the integration branch confirmed all five Pylon-first
resolutions are clean — including the `BrowserDeviceToolbar` equivalence claim,
which holds: upstream's `cn(aspectRatio !== null && …)` guards are constant
inside each ternary branch. It also surfaced two defects that arrived **with**
the upstream commits and exist in upstream `main` too. Both were verified
against the source and consciously **not** fixed in this batch, so the adoption
stays faithful and the fixes get their own review. Tracked as DEF-3 and DEF-4.

1. **`#6466` narrowed `truncated` without narrowing what reads it.** Review-thread
   comments went from `first: 100` plus cursor-following to `first: 10`
   (`gitHubPullRequestJson.ts:696`), so `truncated`
   (`GitHubPullRequestCli.ts:1589`) now means "some thread has an 11th reply"
   rather than "the conversation is short of the host". Three readers were
   written against the old meaning:
   - `PullRequestDetailPanel.tsx:1088` gates `approvalCount` on
     `!detail.commentsTruncated`, so **`#7077`'s approval badge disappears** on
     any pull request with one long thread. The verdicts it counts come from
     `gh pr view --json reviews`, which the provider's own comment
     (`GitHubPullRequestProvider.ts:348`) says is never truncated — the gate
     keys on a signal unrelated to the data it guards.
   - `pullRequestDetail.logic.ts:634` appends the truncation notice to the
     handoff prompt on those same pull requests.
   - `pullRequestDetail.logic.ts:449` serialises `thread.comments` into the
     agent prompt, now the **oldest 10** of a thread where it used to be up to 1000. `#6466`'s new paging is UI-only state inside `ReviewThreadCard` and
     never reaches the prompt builder, so "Fix in a thread" hands the agent the
     opening of a discussion and not its resolution.

   Note the gate is defensible for GitLab, Bitbucket, and Azure DevOps, whose
   `commentsTruncated` derives from conversation reads that do carry verdicts —
   so the fix belongs at GitHub's `truncated`, not at the shared gate.

2. **`#6466`'s GraphQL cost estimate only ratchets upward.** `query` reserves the
   _previous_ query's cost (`githubGraphQlBudget.ts:96`) and `observe` discards
   any response whose `remaining` is `>=` the stored value
   (`githubGraphQlBudget.ts:126`). Reserving always pushes the local figure
   below GitHub's true remaining, so an honest response always looks "higher"
   and is thrown away with its `cost`, `limit`, and `remaining`. The estimate
   updates only when a query costs _more_ than the last, so the 12-point
   review-threads read poisons every subsequent 1-point read for the window.
   The out-of-order guard is right in intent; it just compares against a
   reserved value rather than the last observed one. A failed `gh` call leaks
   its reservation outright, since `observe` runs only on the success path.
   Bounded by the hourly reset, and it fails safe — reads pause early rather
   than quota being overspent.

**One review finding was dismissed.** A task whose first liveness event is a
status-free `progress` cannot register under `#7172`'s new guard
(`ThreadBackgroundLiveness.ts:136`). That matches the module's documented
intent — "After a server restart the registry is empty until new task events
arrive, which matches reality: orphaned background work is not live" — so it is
behavior, not a defect.

**One nit accepted.** The `<td>` row label whose `title` was dropped in
`18fbcc8d5` cannot clip in its own cell, but the table sits inside a
`w-[min(25rem,calc(100vw-2rem))]` popover with `overflow-clip`, so at three or
more accounts on a narrow viewport it can be cut off with no tooltip to recover
it. Low severity; folded into the DEF-3/DEF-4 follow-up if convenient.

### Verification

Typecheck clean across `contracts`, `shared`, `client-runtime`, `web`, `desktop`, `server`
(exit 0; remaining output is pre-existing Effect `suggestion` diagnostics) and `mobile`
separately. Targeted tests: **server 35 files / 707 tests**, **web 32 files / 245 tests**,
**desktop 1 / 7**, **oxlint plugin 1 / 11** — all passing. `vp lint` over the touched trees
reports **0 errors**; `vp fmt --check` clean over 2595 files.

One new lint warning arrived with N5 and was removed in `4719407a6`: `#7083` imports
`EnvironmentId` into `ProviderService.test.ts` without using it. Confirmed dead upstream too,
so it is worth reporting rather than a merge artifact.

**Browser pass**, against the branch with a database seeded from `~/.pylon-code` and live
GitHub data. Confirmed: the new **Settings → Integrations** page lists in the nav, with
`#7083`'s **Agent browser access** enabled and `#7082`'s four client-local defaults dimmed
as one block reading "Only available in the desktop app." — the intended split, since one is
a `ServerSetting` and the others are desktop-local Chromium preferences. `#7209` was checked
at runtime rather than by lint alone: **zero** native `title` attributes remain on intrinsic
elements in the rendered DOM. `#7077`'s Reviewers row renders above the conversation and the
Summary/Timeline/Code tabs load.

**`#7219` was verified on a second pass**, once the usage query was given long enough to
finish against the seeded 334 MB database. The breakdown shows 29 daily rows, Aug 18 back to
Jul 20; restoring the old `.slice(0, 8)` and reloading with the browser cache disabled drops
it to 8, ending at Aug 11. Note the first attempt at that negative control reported 29 rows
for both sides — Vite had reused a warm module graph, so an A/B against a running dev server
needs the cache disabled to mean anything.

**`#6466`'s Load more comments and `#7077`'s verdict rows remain unexercised.** No repository
in reach carries a single approved review, GitHub does not allow approving one's own pull
request, and a disposable clone of `pingdotgg/t3code` added as a project did not surface in
the pull request list, whose repository discovery did not pick it up.

**That search right-sized DEF-3.** Its symptom needs one review thread longer than ten
comments, and across upstream's most-reviewed pull requests the largest thread anywhere was
**five** — `#4849` (100 review comments, largest thread 5), `#7077` (61, 5), `#6466` (24, 3),
`#7107` (14, 3). The defect is real and the fix stands, since the flag asserts something
untrue and its reader drops a feature on it, but it fires on unusually long single threads
rather than on busy pull requests generally.

**Mobile (N7, N8) was not exercised at all.**

## 2026-08-19 — `82b8a9380298509d68170961d9717be62836e490..2aa5f095fc3bb65c00cc4efce66a5473e2d4554a`

Twenty-two upstream commits, ten change sets, one PR. **Twenty commits adopted** onto
`upstream/2026-08-19-batch`; two skipped. `git cherry` reported every one absent from Pylon,
so nothing was patch-equivalent. The deferred register was empty going in and stays empty.

**CS-1 (`#7459`) is the most valuable change here.** It flips the Grok and OpenCode schema
defaults to `false` (Cursor was already `false` in Pylon) and adds
`providerInstanceConfigEnabledFlag` / `resolveProviderInstanceEnabled`, resolving an
envelope-vs-config `enabled` conflict most-restrictively so a user's explicit disable is
never silently undone. **Accepted consequence worth remembering:** `writeSettingsAtomically`
strips values equal to the default, so an install that had Grok on by matching the old
default has nothing written for it and comes back disabled after this change. That is the
point of the commit rather than a regression, but it is a one-way default flip with no
migration, and the sparse-persistence detail means an explicit opt-in is indistinguishable
from an untouched default.

**CS-2 (`#7473` then `#7477`) had to be taken as an ordered pair.** `#7477` deletes
`macArch.ts` and `macArch.test.ts` outright and moves detection into `download.astro` and
`index.astro`, superseding the fix in `#7473`. Adopting only the later commit risks a
delete/modify conflict. The end state deliberately serves **every** Mac the arm64 build from
the hero button, with a code comment saying not to add arch detection back — browsers cannot
tell Apple Silicon from Intel, and Intel users choose on `/download`.

**CS-3 (`#7445` then `#7460`) is likewise inseparable**: the first throttles hidden preview
rendering, the second exempts cold start because the first regressed first paint.

**The launchd change (`#6286`) carried every branding conflict in the batch** — three files,
all resolved Pylon-first by taking upstream's platform-aware behavior and keeping Pylon's
copy. The launch agent label stays the compatibility identifier `com.t3tools.t3code.service`
per AGENTS.md; see the open question below.

Conflicts and adaptations, all resolved Pylon-first:

| File                                                                          | Conflict                                                                                                        | Resolution                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/components/ThreadCommandSubtitle.tsx`                           | `#7392` adds a `ThreadCommandSubtitleVariant` design-review toggle; Pylon had simplified that away              | Kept Pylon's single `WorkspaceIcon(isWorktree)` and dropped the variant harness; adopted the `COMMAND_PALETTE_META_ICON_CLASS` / `CommandPaletteMetaDot` renames the new palette imports. Nothing outside the file referenced the variant. |
| `apps/web/src/components/chat/ChatComposer.tsx`                               | `#7122` against a file that has diverged structurally (Pylon 4240 lines vs upstream 2824)                       | Manual port of the two-line change (import + placeholder constant) onto Pylon's file. Applied byte-wise because the file carries 6 NUL bytes and defeats `grep`.                                                                           |
| `apps/web/src/providerInstances.ts`, `.../settings/ProviderSettingsPanel.tsx` | Import-list collision: Pylon's `providerInstancePrioritySortKey` vs upstream's `resolveProviderInstanceEnabled` | Union — both symbols are used.                                                                                                                                                                                                             |
| `apps/server/src/cli/service.ts`, `apps/server/src/cli/connect.ts`            | `#6286` platform-aware copy written as "T3 Code" / "T3 Connect"                                                 | Took the darwin/else branching, kept Pylon naming.                                                                                                                                                                                         |
| `docs/user/background-service.md`                                             | Same, plus a whole new Platform Support section                                                                 | Adopted the macOS content verbatim except product names; kept the literal `t3code.service` and `com.t3tools.t3code.service.plist` paths because that is what the code writes.                                                              |

Skipped:

| ID    | Upstream             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CS-10 | `db0659fe` (`#7421`) | AUR launcher icon paths. Pylon has no `packaging/aur` directory, so it is not applicable.                                                                                                                                                                                                                                                                                                                                                                                      |
| CS-9  | `324ddda3` (`#6563`) | `npx t3 triage`. 779 insertions whose playbook hardcodes `pingdotgg/t3code`, fetches the playbook from T3's raw GitHub URL, searches T3's issues, and builds a `github.com/pingdotgg/t3code/issues/new` URL. Adopting as-is would funnel Pylon users' bug reports into T3's tracker. Held for a from-scratch Pylon implementation, which needs a product decision first: `pylon-code/pylon` is private, so there is no public tracker for a user's generated issue to land in. |

Review and validation:

- 21 changed test files, **617 tests, 0 failures**. Note for future sessions: `vp test run`
  globs nested worktrees under `.prime/` and `.claude/worktrees/`, which have no
  `node_modules`, producing ~72 phantom module-resolution failures **and still exiting 0**.
  Pass `--exclude '**/.prime/**' --exclude '**/.claude/worktrees/**'` for a real signal.
- Typecheck clean across 8 packages (server, web, desktop, contracts, shared, client-runtime,
  marketing, mobile).
- Validated live in the web client against a seeded copy of real data: pairing, the new
  composer placeholder, Settings → Providers showing Cursor/Grok/OpenCode disabled, and the
  command palette rendering the new project-location subtitle.
- An xhigh review produced 13 findings. One was confirmed and fixed in `7d0a295db`: the
  `#7317` inherited-upstream guard returned without `skipped`, so the caller wiped the
  branch's last-known PR and dropped the Merged-badge fallback — the adjacent
  unpublished-branch guard sets that flag for exactly this reason. **Worth sending upstream.**
  The rest describe upstream design tradeoffs that were adopted as-is rather than rewritten
  inside an adoption PR; the notable ones are recorded below.

Open questions raised by this batch, for a later decision:

- **The launchd label is `com.t3tools.t3code.service`.** AGENTS.md forbids renaming
  compatibility identifiers during adoption, so it was kept. But Pylon's stated goal is that
  Pylon and T3 Code can be installed side by side, and both would now claim the same launch
  agent label and TCC records on one Mac. Upstream's own comment says the label is chosen so
  those never collide — which only holds for a single product.
- **`QuitHold`** (`#7397`) clears its watchdog on entering `quitOnRelease` without installing
  a replacement, so if key events stop arriving mid-hold the "Hold to Quit" overlay can stay
  up with no quit.
- **The launchd plist has no `StartLimitBurst` equivalent**, so a server that cannot boot
  respawns every 5 seconds indefinitely where systemd gives up after 5 failures in 300s.
- **`backgroundThrottling` now has two independent owners** — `#7460`'s first-reveal trigger
  and `#7445`'s frame-capture accounting — with no shared state between them.
- **A muted preview tab loses its speaker affordance** once the guest goes silent
  (`tabAudioState` returns "none"), leaving no in-strip way to see or undo the mute.

## 2026-08-19 (second) — `2aa5f095fc3bb65c00cc4efce66a5473e2d4554a..f2d5fc91e3030e5c3956fdadc13e1eaa25bcabe3`

Three upstream commits, three change sets, one PR. **All three adopted** onto
`upstream/2026-08-19-batch2`. `git cherry` reported every one absent from Pylon. The
deferred register was empty going in and stays empty.

**N3 (`#7522`) supersedes work adopted hours earlier in the first 2026-08-19 batch.**
`6a687ee4` had added a local shim in `apps/web/src/main.tsx` overriding
`isAutoFillSupported` to `false`, because `@clerk/electron` reported passkey autofill as
supported while executing the "quiet" request as a modal OS dialog — so the sign-in form
popped a system passkey prompt the moment it mounted. Upstream has now deleted that shim
in favour of a library fix (clerk/javascript#9500).

**The developer chose to adopt it to stay in step with upstream, over a recommendation to
defer.** The trade was stated plainly and decided: Pylon already had correct behavior from
the shim, so adoption buys no user-visible change, and the cost is six **canary**
prereleases pinned to one dated build (`v20260819050620`) — `@clerk/electron`,
`@clerk/electron-passkeys`, and four platform-specific native binaries
(`darwin-arm64`, `darwin-x64`, `win32-arm64-msvc`, `win32-x64-msvc`) — all added to
`minimumReleaseAgeExclude`, plus reliance on the explicitly-internal
`__internal_clerkUIVersion` prop. At adoption time `npm view @clerk/electron dist-tags`
still reported `latest: 0.0.33`; there is no stable `0.0.34`.

**Follow-up this creates:** unpin the canaries once Clerk promotes a stable release
containing PR #9500. Check with `npm view @clerk/electron dist-tags` — when `latest` is
`0.0.34` or newer, move the catalog off the canary strings and drop the six
`minimumReleaseAgeExclude` entries. Until then Pylon ships prerelease native binaries in
its desktop builds.

**N2 (`#6562`)** reorders desktop shutdown so the window closes before cleanup runs
rather than hanging visible through it, threading `ElectronWindow` into lifecycle
registration. It is adjacent to `#7397` (`QuitHold`) adopted in the first batch but does
not address that commit's watchdog gap, which stays open.

**N1 (`#7491`)** is a one-line Tailwind fix adding `flex items-center` so sidebar status
pills align with project names.

Conflicts and adaptations, all resolved Pylon-first:

| File                                                     | Conflict                                                                                                                                               | Resolution                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/app/DesktopLifecycle.test.ts`          | `#6562` hoists the inline Electron fakes to module-scope helpers and deletes the per-test copies; Pylon's copy carried `name: Effect.succeed("Pylon")` | Took upstream's deletion — the test body below now calls `makeElectronAppLayer(appListeners)` — and restored Pylon's product name on the hoisted fake, which had arrived as "T3 Code".                                                      |
| `apps/web/src/components/clerk/electronPasskeys.test.ts` | New test stubs `location` as `t3code:` / `app` with rpId `clerk.t3.codes`                                                                              | Rewritten to Pylon's `pylon-code:` renderer protocol and a placeholder rpId. Behavior is identical either way: `originCanSatisfyRpId` can never be satisfied by a custom scheme, which is what pushes both assertions onto the native path. |

Validation:

- 3 changed test files, **13 tests, 0 failures** (with the `.prime/` and `.claude/worktrees/`
  excludes noted in the previous batch).
- Typecheck clean for `@t3tools/web` and `@t3tools/desktop`, both confirmed to have
  actually run rather than filtered to nothing.
- `vp i` resolved the canary native binaries on darwin-arm64 and the lockfile passed the
  supply-chain policy check. The other three platform binaries are unverified here.

## 2026-08-19 (third) — `f2d5fc91e3030e5c3956fdadc13e1eaa25bcabe3..a850895f6833b99d90fc6c50192b5eaa4966d5c7`

Eleven upstream commits, seven change sets, one PR. **Ten adopted, one skipped** onto
`upstream/2026-08-19-batch3`. `git cherry` reported every one absent from Pylon. The
deferred register was empty going in and stays empty.

**The skip is the important part of this batch.** `80c37f1a7` (`#6420`) hides opencode's
plan agent when legacy plan mode is off — and legacy plan mode is a setting Pylon does not
have. Its `planModeEnabled` flag arrived upstream in `48aa875c0` (`#5551`), which this
ledger records as **skipped at F6**: Pylon keeps plan mode as a first-class composer
affordance, and H1 later confirmed "Pylon has no `planModeEnabled` flag". The cherry-pick
conflicted in `SettingsPanels.tsx` and `modelSelection.ts` precisely because it tried to
reintroduce the rejected Settings row. Adopting it would have dragged in the setting F6
deliberately refused. **Skipped as a dependent of a skipped commit** — the same reasoning
should apply to any future `#6420`-adjacent work.

**`#7153` carried the only substantial conflict.** It extracts the sidebar footer into a
`SidebarUtilityMenu`, generalizing `onFooterPage` (usage + pull requests) into
`currentFooterPage` (settings + usage + pull requests). Pylon's footer had diverged
47/-24 from upstream's parent through three Pylon-only commits — `b2a4dcd1f` (compact
footer actions), `7a32d19b9` (back button on the usage page), and `dfd869c2f` (Claude
account drain pill). Resolution took upstream's side on all five hunks after confirming
its `SidebarUtilityItem` is markup-identical to Pylon's compact row and that
`SidebarAccountDrainPill` lives in `SidebarChromeFooter`, outside the conflicted block.

**That resolution then broke typecheck twice, and no test caught it** — nothing covers
`SidebarChrome.tsx`. Taking upstream's import line dropped `useId`, which Pylon's own
`PylonMark` cube logo uses, and `canGoBack` ended up declared twice because upstream's
refactor absorbed Pylon's back-button declaration. Fixed in `d5eb43421`. Worth
remembering: for a file where fork divergence is behavioral rather than textual, typecheck
is the only gate.

Conflicts and adaptations, all resolved Pylon-first:

| File                                                                                    | Conflict                                                                  | Resolution                                                                                                                                                           |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`                                     | `#7153` extracts the footer menu; Pylon had three fork-only commits in it | Took upstream's five hunks after verifying markup equivalence and that the drain pill sits outside the block. Repaired `useId` and duplicate `canGoBack` afterwards. |
| `docs/user/source-control.md`                                                           | `#7588` adds a `gh` version requirement written as "T3 Code"              | Rebranded. A second added line was missed on the first pass and caught by review.                                                                                    |
| `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/modelSelection.ts` | `#6420` reintroduces the rejected `planModeEnabled` Settings row          | Not resolved — the commit was skipped (see above).                                                                                                                   |

Review and validation:

- 17 changed test files, **238 tests, 0 failures**.
- Typecheck clean across web, desktop, server, shared, and contracts.
- An xhigh review produced 14 findings. Three fixed in `0cd9b2593`; the rest describe
  upstream implementation choices adopted as-is.

**One reviewer finding was investigated and deliberately rejected.** It called the install
button vanishing during an update check a regression from `#6269`. Half right: `#6269` does
remove the guard that skipped checks while an update was downloaded, so the poller now runs
one every four minutes and the button does blink. But hiding install while checking is
older, explicitly tested behavior — `desktopUpdate.logic.test.ts` asserts "hides the
install action while checking for a newer release" — and re-checking a queued update is the
entire point of `#6269`. Changing `resolveDesktopUpdateButtonAction` broke that test, which
is the correct signal. The interaction is upstream's trade, recorded here rather than
unpicked inside an adoption PR.

Fixed from the review:

- **Usage listed every supported provider**, used or not. `#7147` switched the summary
  column from `merged.providers` to `PROVIDER_ORDER`. This is worse in Pylon than upstream
  because Cursor, Grok, and OpenCode became disabled by default the day before, so a normal
  install buries its one real provider under four `0 sessions · $0.00` rows.
- The missed `docs/user/source-control.md` branding line.
- `handleUsageClick` still inlining the mobile-sidebar close that `#7153` extracted.

Still open from this batch, not acted on:

- `ElectronMenu.ts` never resets `sectionStartedByExplicitSeparator`, so a destructive item
  not adjacent to an explicit separator loses its automatic one. Latent today because
  `buildThreadActionMenuItems` happens to place them adjacently.
- "Close others" / "Close to the right" / "Close all" skip the terminal close confirmation
  that `#7592` added to closing a single terminal — the more destructive path is unguarded.
- `PullRequestDetailPanel`'s new early return renders the summary ghost for every tab,
  dropping the per-tab skeletons whose removed comment explained they existed to stop a
  summary outline flashing under a timeline heading.
- `rightPanelAvailable` in `_chat.pull-requests.tsx` narrowed to "a pull-request surface is
  selected", which can disable the only control that closes an already-open panel.
- OpenCode's new `debug skill` probe forces the inventory retry path — a fixed one-second
  sleep and a redundant respawn on every provider status check — when the subcommand is
  missing or errors.
- `flattenOpenCodeSkills` copies the full description into `shortDescription` and never
  sets `scope`, unlike the Codex and Claude adapters.

## 2026-08-19 (F6 reversal) — legacy plan mode

Not a batch: a reversal of a standing decision, recorded so the ledger does not
keep asserting something that is no longer true.

**F6 (`48aa875c0` / `#5551`) was skipped** on the argument that plan mode is
first-class in Claude Code and Codex, so dropping the composer's Build/Plan
toggle would cost Pylon more than it cost T3. **H1 extended it** by dropping
upstream's plan-mode Settings row. The developer has since concluded the toggle
goes unused in practice and asked to match upstream.

Pylon now has a `planModeEnabled` client setting, default off, gating the
composer toggle and the `/plan` and `/default` slash commands, with `ChatView`
forcing the effective mode back to `"default"` while it is off so no thread is
stranded in plan mode with its toggle hidden. Pylon Mobile already carried a
device-local `planModeEnabled` preference documented as the counterpart of this
key, so the surfaces now agree rather than diverge.

**Ported, not cherry-picked.** `#5551` is 338 commits back and touches
`ChatComposer.tsx`, which has diverged hard — 4240 lines here against upstream's
2824 — and its Beta-panel placement plus `sidebar-v2` search entries were
superseded upstream anyway. Replaying that snapshot would have imported a shape
neither project has. Pylon implements upstream's current end state instead.

With the flag in place, **`80c37f1a7` (`#6420`) was adopted**, closing the skip
recorded in the third 2026-08-19 batch. Its two conflicts were additive and
unioned; the `legacy-plan-mode` settings-search id is registered against
`/settings/general`, where Pylon keeps its other legacy rows.

F6 and H1 stay in their original batch tables as historical record — they
describe what was decided then. This entry is what supersedes them.

## 2026-08-20 — `a850895f6833b99d90fc6c50192b5eaa4966d5c7..beab6886f45bf42906d0bd01aefe5dfe9e66a867`

Eight upstream commits, four change sets. **Six adopted** onto
`upstream/2026-08-20-batch`; **two deferred** (see DEF-5). `git cherry` reported every
one absent from Pylon. The register was empty going in and gains one entry.

**`#7602` closes the canary follow-up opened by the second 2026-08-19 batch.** It moves
`@clerk/electron` to stable `0.0.34`, `@clerk/electron-passkeys` back to `0.0.3`, and
deletes all four platform-specific native canary entries from `minimumReleaseAgeExclude`.
Verified against the condition the ledger recorded: `npm view @clerk/electron dist-tags`
now reports `latest: 0.0.34`. Pylon no longer ships prerelease native binaries, and the
"only darwin-arm64 was ever exercised" risk retires with them.

**`#7150` and `#7152` are deferred, not skipped.** `#7150` rewrites 1084 lines of
`ChatComposer.tsx` — a file with 50 Pylon commits, structurally divergent at 4837 lines
against upstream's 2824. A full pass was made: all 11 conflict blocks were classified and
individually resolved, keeping Pylon's settle loop, `resolvedRuntimeMode`, the 169 lines
of Quick question and session-resource controls, and the ThreadHandoffTab wrapper, while
taking upstream's drawer measurement and its 335-line drawer structure. The result did
not compile — 8 JSX errors — because upstream flattens the fragment and nested
provider-frame divs into one `<form>` and its added tree cannot be hosted by Pylon's
layers. The two are ends of one restructure. `#7152` then conflicts on
`MessagesTimeline` because it genuinely depends on `#7150`.

**One conflict resolution leaked a secret and Pylon's own test caught it.** Adopting
`#7151` as a plain union put upstream's unconditional `toolCallId: event.itemId` beside
Pylon's `primeAgentTool` gating rather than behind it. A Prime tool's itemId is a
canonical filesystem path, so the projection began carrying
`canonical-prime-tool-/private/native-secret` — exactly what the gating exists to
withhold. Fixed in `0d70d9aec`; the guarding assertion lives in
`ProviderRuntimeIngestion.test.ts`.

Conflicts and adaptations, all resolved Pylon-first:

| File                                                               | Conflict                                                                                                                          | Resolution                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` | `#7151` adds `toolCallId`, `status`, and `data` spreads to three tool payloads; Pylon gates the same payloads on `primeAgentTool` | `toolCallId` placed behind Pylon's gate; upstream's `status` kept for non-Prime alongside Pylon's derived Prime status; `tool.started` regained upstream's `data`. A later review collapsed the status ternary — both arms were identical. |

Review and validation:

- 4 changed test files, **115 tests, 0 failures**; the projection suite is 20 after the
  test added below. Typecheck clean across 7 packages, each confirmed to have run.
- Validated live in the web client against a seeded copy of real data: pairing, thread
  view, the Usage page including the "Hourly cost by provider" chart, and Settings →
  Appearance with its theme list and Import theme. No error surfaces anywhere.
  **Not verified:** `#7595`'s chronological hour ordering — the chart exposes no hour
  labels to the DOM, so ordering could not be asserted from the browser.
- An xhigh review produced 13 findings. Two were fixed in `2cf95d544`. The rest are
  upstream design decisions adopted as-is; the ones worth acting on later are below.

Open questions raised by this batch:

- **The snapshot dedupe widened.** `toolLifecycleIdentity` now prefers a payload-level
  `toolCallId`, and `#7151` sets one on every tool activity, so identity is `id:<itemId>`
  where it used to fall back to itemType/title/detail. The clients read only
  `data.toolCallId` (`session-logic.ts` `extractToolCallId`, mobile's
  `deriveToolLifecycleCollapseKey`), so they cannot mirror it: in-flight rows with
  differing details render live and collapse after a reload. A test now pins the
  behavior; whether it is the behavior Pylon wants is undecided. The doc comment on
  `dropSupersededToolUpdatedActivities` still asserts an invariant measured under the old
  identity.
- ~~`toolLifecycleIdentity`'s fallback joins with no separator.~~ **Withdrawn — false
  positive.** The separator is a unit-separator character, which is invisible in source
  output, so the call reads as `join("")` in a terminal and in review tooling; `cat -v`
  shows the real `join("^_")`. Pylon and upstream are byte-identical here. Recorded so
  the same illusion does not get re-reported.
- **`tool.started` now persists the provider's full unprojected `data`.** The
  `item.updated` branch wraps in `projectActivityPayload`; `tool.started` does not, so a
  large Write stores the whole body — and both clients skip `tool.started` rows entirely.
- **`#7642` doubles `MAX_UNCOMPRESSED_BYTES` to 100 MB** and raises `MAX_ZIP_ENTRIES`, a
  relaxation of an anti-zip-bomb guard, to accommodate extensions shipping `node_modules`
  the importer never reads. Bounding only the theme payload would fix the class.
- **`#7595` made the Past-24h empty state unreachable**: `hours` is always 24 entries, so
  an idle day renders 24 `$0.00` rows instead of "No activity in this window."

## 2026-08-20 (DEF-5) — composer state drawers

**DEF-5 adopted and retired.** `#7150` and `#7152` are in, on branch
`upstream/def-5-composer`. The register is empty again.

The first attempt merged upstream's diff into Pylon's composer block by block and
compiled to 8 JSX errors: upstream flattens the fragment and provider-frame divs into
one `<form>`, and Pylon's layers cannot host its drawer tree. The two are ends of one
restructure, so the merge could not converge in that direction.

**What worked was reversing it.** Take upstream's composer as the base, then replay
Pylon's divergence onto it with `git apply --3way`. That is the same reconciliation
pointed the way that converges: 8 conflicts instead of a hand-rebuild of 1460 lines, and
every non-structural Pylon feature applied clean. The developer chose this direction
explicitly — maximum fidelity to upstream over minimum divergence.

Resolved Pylon-first where the two genuinely disagree:

| Conflict                                                        | Resolution                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command-menu position                                           | Pylon's settle loop from `ce5371d41` with upstream's drawer-aware measurement inside it. Upstream schedules from a plain ResizeObserver on the ancestors, which that commit established does not fire while the composer glides into place — the bug it fixed and browser-verified at 2200px. Measurement kept, scheduling not. |
| Runtime mode                                                    | `resolvedRuntimeMode` / `supportedRuntimeModes` over upstream's plain `runtimeMode`, at the footer and the compact controls menu.                                                                                                                                                                                               |
| Quick question, session resources, ComposerPrimaryActions props | Pylon's, which are supersets.                                                                                                                                                                                                                                                                                                   |
| Form root, drawer tree, inline task/stash badges                | Upstream's.                                                                                                                                                                                                                                                                                                                     |

**`ThreadHandoffTab` was lost and restored.** It lived in the form root upstream replaced,
so it survived as an unused import — invisible to typecheck. A symbol-by-symbol sweep of
20 Pylon composer features against `origin/pylon` caught it. **`#7152` also deleted
`activeTurnInProgress` as collateral** across ChatView, the props interface, the row
activity context, and the shared test fixture — upstream never had it, so its diff context
swept it up. Both are worth remembering: a green typecheck does not prove a three-way
merge preserved fork-only code, and the sweep is what does.

MessagesTimeline was reconciled rather than replaced — its divergence is only ~93 lines —
unioning upstream's `isExpandedToolGroupEntry` plumbing with Pylon's response-status label,
session-notification row, failure/success/neutral indicators, and its `DotMatrix` marker
(upstream's replacement is three staggered pulsing dots that repaint every vsync).

Validation: typecheck clean across 7 packages, 370 tests over 26 composer and timeline
suites, and a live pass confirming the composer renders with both upstream drawer hooks and
the command menu positions to upstream's exact drawer math (offset 22px = the inset, width
= form width less twice it). **Not verified in a browser:** the settle loop's dynamic
re-anchoring, because the composer could not be made to move in the test environment, and a
thread exercising `#7152`'s collapsed tool rows.

## 2026-08-21 — `beab6886f45bf42906d0bd01aefe5dfe9e66a867..730ce9edd9873144c1d2b01e5f1c85414c3760ad`

Eight upstream commits, five change sets. **Seven adopted** onto
`upstream/2026-08-21-batch`; **one deferred** (DEF-6). `git cherry` reported every one
absent from Pylon. The register was empty going in and gains one entry.

**Two of these walk back work adopted the day before, which is the fork strategy behaving
as intended.** `#7718` reverts `#7595`, whose Past-24h breakdown rendered 24 rows of
`$0.00` on an idle day — a defect an xhigh review flagged here and the ledger recorded as
an open question. Upstream found it too and reverted, so the wart leaves with the revert
and a 110-line `UsagePage.test.tsx` arrives with it. `#7089` partially reverses `#7459`,
which had been adopted as the most valuable change of the first 2026-08-19 batch.

**`#7089` is deferred because upstream's own CI is failing on it.** Their CI is green at
`5ff5f735e` and red at `730ce9edd`. The commit flips Cursor's default to `true` and adds
`enables every built-in provider by default`, which expects `grok` and `opencode` to be
`true` — but upstream's schema still has both `false`, and the pre-existing
`enables only the stable bindings by default` expects all three `false`. Both tests are in
upstream's tree and cannot both pass. Probing the commit onto Pylon reproduced exactly
that: it applies cleanly, then both tests fail. Adopting it would import a known-broken
commit.

**`#7719` is the substantial one** at 743 insertions, though roughly 650 of that is two new
test files. Only 88 lines touch `serverRuntimeStartup.ts`, which carries just two Pylon
commits, and a stuck session at startup no longer aborts global startup.

Conflicts and adaptations, all resolved Pylon-first:

| File                                                                                           | Conflict                                                                                                    | Resolution                                                                                                                              |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/ChatView.tsx`                                                         | `#7664` adds a `client-runtime/errors` import beside Pylon's turn-cost and side-question imports            | Union.                                                                                                                                  |
| `orphanedProviderSessionStartup.integration.test.ts`, `serverRuntimeStartup.reconcile.test.ts` | `#7719` stubs `ProviderServiceShape` with the ten members upstream has; Pylon's shape carries nineteen more | Stubbed to `Effect.die("unused")` with `watchSessionAgentActivity` returning an empty stream, matching `ProviderSessionReaper.test.ts`. |

Validation:

- Typecheck clean across 7 packages, each confirmed to have run.
- The three new upstream suites pass; no tracked file is unformatted.
- **Two local-only failures were investigated and are not regressions.**
  `runtimeAbi.test.ts` fails to load `ghostty-vt.wasm?inline` and
  `accountDrainEndToEnd.test.ts` times out at 60s — both fail identically on unmodified
  `origin/pylon`, and `pylon`'s CI is green, so both are local environment differences.
  Worth knowing before chasing either.

Process note: `vp check --fix apps packages` applies lint autofixes beyond formatting. It
rewrote an unrelated `ids.includes` into a `Set` in `ProjectionSnapshotQuery.test.ts`,
which was reverted to keep the batch scoped. Prefer `vp fmt` on the specific files, or
review what `--fix` touched before committing.

## 2026-08-21 (second) — `730ce9edd9873144c1d2b01e5f1c85414c3760ad..be7d35aaeb49a04483ec5e0d2284e8b5b70a3b6e`

Twenty-three upstream commits, twenty-one change sets, plus DEF-6 coming due. **Twenty
adopted** onto `upstream/2026-08-21-second-batch`; **three skipped**. `git cherry` reported
every one absent from Pylon. The register had one entry going in and is empty coming out.

**DEF-6 came due and was adopted.** `#7725` (`fe875020`) is the reconciliation the deferral
was waiting for: it deletes the `enables every built-in provider by default` test that
contradicted `enables only the stable bindings by default`, and updates the survivor to
expect `cursor: true`. Upstream's head is self-consistent again. Re-probed exactly as the
register instructed — `#7089` + `#7725` cherry-picked onto a scratch branch, 39/39 pass in
`settings.test.ts`, which a repo-wide grep confirms is the only place asserting a cursor
default. Net effect: Cursor is probed on fresh installs again, while `#7459`'s substance
survives because Grok and OpenCode stay `false`.

| ID    | Upstream                                 | Decision | Pylon commit             | Notes                                                                                                                                                                                                                                |
| ----- | ---------------------------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DEF-6 | `#7089` + `#7725`                        | adopted  | `c438de541`, `2492437f9` | Retires the register's only entry. See above.                                                                                                                                                                                        |
| CS-1  | `#7103` `1afe5545b`, `#7676` `6d5c6c4a6` | adopted  | `988e0c902`, `94757c591` | Pinned threads stop jumping and reshuffling after a drag. Directly serves a Pylon feature — pinning carries Pylon's own renumbered migrations 037/040.                                                                               |
| CS-2  | `#7292` `f3fcfe1f6`                      | adopted  | `80ec5302b`              | Sidebar provider icons resolve per environment. Default instance ids are driver slugs, so the old flat map collided across environments — a bug Pylon's remote/multi-environment emphasis makes likelier to hit.                     |
| CS-3  | `#7277` `ce8ca5bb3`                      | adopted  | `5b7f961d6`              | Thread-jump hints hide while the terminal has focus, instead of advertising a shortcut that types into the shell.                                                                                                                    |
| CS-4  | `#6519` `e2697d63e`                      | adopted  | `f469c0875`              | Scrolling back to the live edge resumes following the stream, by releasing the send-time anchor that kept `maintainScrollAtEnd` off.                                                                                                 |
| CS-5  | `#7737` `e723501227`                     | adopted  | `e7c269276`              | Skills listed in the composer slash menu, web and mobile.                                                                                                                                                                            |
| CS-6  | `#7740` `68966c1e6`                      | adopted  | `0b2756131`              | Space above the composer shoulder tabs; collapses two duplicated four-term conditions into `showShoulderTabs`.                                                                                                                       |
| CS-7  | `#7741` `6d3bf01b4`                      | adopted  | `81f2c6905`              | File-link tooltips show the full path instead of repeating the chip.                                                                                                                                                                 |
| CS-8  | `#7485` `18f6d0348`                      | adopted  | `aa578a97e`              | Terminal encodes shifted characters correctly via `ghosttyConsumedMods`.                                                                                                                                                             |
| CS-9  | `#7561` `be7d35aae`                      | adopted  | `5570d4793`              | Preview loading bar moves from a rAF/React-state loop to a CSS `scaleX` animation and deletes `useLoadingProgress`. Finite, compositor-driven, honors `prefers-reduced-motion` — consistent with Pylon's no-continuous-repaint rule. |
| CS-10 | `#7580` `f0fb83aff`                      | adopted  | `23a2bf262`              | Theme library buttons, search, and import dialog polish.                                                                                                                                                                             |
| CS-11 | `#7697` `20e5a3396`                      | adopted  | `76bec3343`              | **Security.** Pylon accepted any `vscode:`/`cursor:`/`windsurf:` URL for the OS handler; this narrows it to a `vscode-remote` host with an `/ssh-remote+` path and no embedded credentials.                                          |
| CS-12 | `#7659` `4bdbd8ce1`                      | adopted  | `5de72ea62`              | Keeps `gpt-daybreak-*` out of the legacy-model bucket.                                                                                                                                                                               |
| CS-13 | `#6409` `820e5639c`                      | adopted  | `8a6eda454`              | HTML assets served with `charset=utf-8`.                                                                                                                                                                                             |
| CS-14 | `#6326` `12c497083`                      | adopted  | `ba96e0601`              | `git worktree add` gets 300s instead of 30s; a 375k-file repo takes ~40s.                                                                                                                                                            |
| CS-15 | `#7760` `549201fcf`                      | adopted  | `5b786060c`, `b83d50ad8` | GitHub clones default to HTTPS and `owner/repo` normalizes to a GitHub URL. User-visible, so `docs/user/source-control.md` gained a line.                                                                                            |
| CS-16 | `#7286` `d7b9a689f`                      | adopted  | `7a3e8ed8a`              | CI parallelization. **Manual port, not a cherry-pick** — see below.                                                                                                                                                                  |
| CS-17 | `#7283` `8f7da3b99`                      | skipped  | —                        | Gates the macOS native lint runner on native paths. **Pylon already solved this**, better: PR #51 moved the check into its own `ci-mobile-native.yml` with a native GitHub path filter, no gate job and no extra action dependency.  |
| CS-18 | `#7762` `9f12eab38`                      | adopted  | `b0b551d3f`              | CI guard, gitignore, and AGENTS.md rule rejecting committed `.github/pr-assets/`. Pylon had none, so this is pure prevention.                                                                                                        |
| CS-19 | `#7665` `9167622a4`                      | adopted  | `ca5114ee3`, `044f511f9` | Plans out of the repository. Developer chose full adoption. See below.                                                                                                                                                               |
| CS-20 | `#7728` `7107a98a2`                      | skipped  | —                        | Vouches two upstream contributors. `.github/VOUCHED.td` is fork governance; Pylon's list already diverges by 5 insertions / 18 deletions.                                                                                            |
| CS-21 | `#7658` `45a2c4b2a`                      | skipped  | —                        | Upstream's user count 100k → 200k. Pylon's AGENTS.md prose is fork-specific.                                                                                                                                                         |

**CS-19 was larger than its commit title.** `#7665` reads as a deletion but also adds
`docs/internals/work-artifacts.md`, an AGENTS.md "Plans and work artifacts" section, a
`docs/README.md` index entry, a `vite.config.ts` ignore-pattern removal, and two test
fixtures that referenced `.plans/` paths. Upstream deleted 32 files; Pylon tracked 34. The
two survivors — `prime-agent-integration.md` and `prime-agent-native-parity.md` — are live
design documents for a shipping Pylon provider, not abandoned intentions, so the adopted
policy's own rule applied: durable architecture goes to `docs/internals/`. They moved there
and were added to the docs index, rather than being deleted or stranded as tracked files
inside a now-gitignored directory.

**CS-16 is the only hand-written change here.** Pylon's `ci.yml` had diverged too far for
upstream's diff to apply. Ported: `--parallel` for the non-server suites, three shards for
`apps/server` (278 test files at `fileParallelism: false`, up from upstream's 239), and Rust
split into its own 4vcpu job. Two Pylon-first departures:

- The transfer-result upload keeps `continue-on-error: true` from Pylon's own #9 fix **and**
  gains upstream's presence gate. They guard different failures — the gate stops the two
  shards that legitimately produce nothing from racing for the artifact name; the flag stops
  an exhausted org artifact quota from failing a run whose tests passed. Taking either alone
  would have lost a real protection.
- Both test jobs pass `--fail-if-no-match`, which upstream does not use. Without it a filter
  matching no package only warns and exits 0 — exactly the silent no-op AGENTS.md warns
  about, and a renamed package would turn a test job green having tested nothing.

Conflicts, all resolved Pylon-first:

| File                        | Conflict                                                                                               | Resolution                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChatComposer.tsx`          | Pylon wraps the form in a fragment for `ThreadHandoffTab`, shifting every line by two spaces           | Kept Pylon's tree, applied upstream's three edits by hand with a byte-level script — the file holds six NUL bytes that defeat `grep` without `-a`, and the merged result matches upstream's own +14/-11. |
| `providerInstances.test.ts` | Pylon's `rateLimit` and upstream's `accentColor` are adjacent optional spreads in the same test helper | Both kept; git had already merged the input type union cleanly.                                                                                                                                          |
| `MessagesTimeline.test.tsx` | Upstream's new end-following test lands exactly where Pylon's revert-capability test sits              | Both kept.                                                                                                                                                                                               |

Validation:

- 19 test files / 374 tests across web, contracts, client-runtime, desktop, mobile, and the
  two touched server suites — all pass.
- Typecheck clean across 6 packages, each confirmed to have run. The remaining diagnostics
  are pre-existing Effect `suggestion` hints in files this batch never touched.
- `actionlint` on the rewritten `ci.yml` reports nothing beyond the pre-existing unknown
  Blacksmith runner labels.
- The sharded server command was run locally before being trusted in CI.

Recorded, not fixed: `ThemeSearchSection.tsx`'s search effect carries a comment saying
`installingId` and `sortBy` are "deliberately not dependencies" when `installingId` is in
the dependency array — only `sortBy` is omitted — above an
`// eslint-disable-next-line react-hooks/exhaustive-deps` that is inert, because this repo
lints with oxlint. `vp check` on the file reports no warnings, and our copy is byte-identical
to upstream's, so correcting the comment would trade a clean file for divergence. Left for
upstream to fix, the same way `#7718` handed back `#7595`'s defect for free this batch.

Known follow-up, deliberately not in this batch: `docs/internals/work-artifacts.md` arrives
carrying the `> For maintainers. Using T3 Code? See docs/user` banner. That is not a
regression this batch introduced — every sibling in `docs/internals/` already carries the
same line, so the new file matches its neighbours. Fixing one file would leave the set
inconsistent; the whole `docs/internals/` banner sweep belongs in a dedicated branding PR.

## 2026-08-23 — `be7d35aaeb49a04483ec5e0d2284e8b5b70a3b6e..30be31195883635aba96031a8d79c255fb28b438`

Twenty-seven upstream commits, twenty-six change sets, **all adopted** onto
`upstream/2026-08-23-batch`. `git cherry` reported every one absent from Pylon. A read-only
`git merge-tree` probe predicted five conflicts before any branch existed; all five landed
where predicted. The register was empty going in and is empty coming out.

**One standing revisit condition was retired.** The 2026-08-04 `U-4326` row said "revisit
when `#4326` merges". It never will: `#4326` is **closed, unmerged**. Pylon's manual port of
provider usage limits is now permanently Pylon-owned code with no upstream form to reconcile
against, so that row's condition is dead rather than pending. Recorded here because the row
lives in a batch table, not the register, and would otherwise wait forever.

| ID    | Upstream                                 | Decision                  | Pylon commit             | Notes                                                                                                                                                                          |
| ----- | ---------------------------------------- | ------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CS-1  | `#7792` `0a46daaf6`                      | adopted                   | `88e258007`              | Timeline scrolls when a composer banner grows, instead of leaving messages behind it.                                                                                          |
| CS-2  | `#7817` `837f6b871`                      | adopted                   | `05937cb19`              | Double-click the chat header title to rename a thread.                                                                                                                         |
| CS-3  | `#7772` `292c6dd8c`                      | adopted                   | `e90d7c4c9`              | Model picker double border.                                                                                                                                                    |
| CS-4  | `#7796` `9b5d41687`                      | adopted                   | `f7e146bcc`              | Tooltip on the sidebar un-settle button — a reverse state that was reachable but unlabelled.                                                                                   |
| CS-5  | `#7809` `c3e37094e`                      | adopted                   | `be9d13ea4`              | Terminal codepoints convert in 4k chunks so a long combining-mark run stops blowing the spread-argument cap.                                                                   |
| CS-6  | `#7821` `e0b4f4639`                      | adopted                   | `374ca28e4`              | Cmd+Enter creates a thread in the background. **Conflict** — see below.                                                                                                        |
| CS-7  | `#7794` `b381fdb12`                      | adopted                   | `2be8f63e4`              | Launcher shortcuts stop hijacking the empty composer. **Pylon had already fixed this independently**; upstream's version won on merit — see below.                             |
| CS-8  | `#7823` `44e4a7071`                      | adopted                   | `d7e881517`              | Project icons can come from outside the workspace. Widens `AssetAccess` past workspace-root containment — see below.                                                           |
| CS-9  | `#7845` `592c5983c`                      | adopted                   | `4e09640f5`              | Terminal mouse-motion reports dedupe. Serves both Pylon principles at once: fewer frames and a smaller websocket payload.                                                      |
| CS-10 | `#6633` `421088c27`                      | adopted                   | `f89682efd`              | Malformed thread-search keys decode to `Option.none` instead of throwing through the atom family.                                                                              |
| CS-11 | `#7086` `035058a23`                      | adopted                   | `99ed4a893`              | Cloud environments filter on `isRelayManaged`, so a directly-saved backend stops hiding the cloud environment sharing its id. Doc comment reworded off "T3 Connect".           |
| CS-12 | `#7774` `11f051373`                      | adopted (with adaptation) | `848d5e0c2`              | Client-origin plumbing. **Migration renumbered 041 → 045, and the three PostHog events were deliberately dropped** — see below.                                                |
| CS-13 | `#7893` `ce91284f8`                      | adopted                   | `7da6053de`              | A tool group's failure indicator reflects its last entry rather than any entry, so a failure followed by a successful retry stops reading as failed. Visible behavior change.  |
| CS-14 | `#6439` `f34b9d31b`                      | adopted                   | `67cd7461d`              | Command-click on folder links containing spaces.                                                                                                                               |
| CS-15 | `#7897` `2274444e9`                      | adopted (with adaptation) | `3d49297ef`              | Anchor scan runs forward and stops at the first anchored item, so follow-ups stop jumping to the top. Web, mobile, and shared. Prop renamed for Pylon — see below.             |
| CS-16 | `#7873` `0ede2ed0d`                      | adopted                   | `a3e109013`              | Drops a redundant release-note assertion.                                                                                                                                      |
| CS-17 | `#7856` `2c4158f87`                      | adopted                   | `9d8f96d91`              | Wide ordered-list markers.                                                                                                                                                     |
| CS-18 | `#7213` `49c2b4471`                      | adopted                   | `49566000e`              | Remote launch runs under `sh -l`, so the user's PATH loads and a provider CLI installed via a shell profile is found. Directly serves remote-ready.                            |
| CS-19 | `#7116` `d9c1732b2`                      | adopted                   | `38822cbfc`              | A tailscale spawn defect no longer takes the advertised endpoints down with it. Pylon ships the tunnel path.                                                                   |
| CS-20 | `#4503` `dedcd99a9`                      | adopted                   | `757dd45ae`              | Codex service-tier labels stay readable.                                                                                                                                       |
| CS-21 | `#6433` `77c9d1eb5`, `#7940` `5a7a7cf29` | adopted                   | `2aa153361`, `9f4439aed` | Workspace images render in chat markdown (web, mobile, iOS native) and keep their intrinsic dimensions. `#7940` conflicts alone and applies cleanly once `#6433` lands.        |
| CS-22 | `#7723` `6c693baec`                      | adopted                   | `0f6f2e5f5`              | A turn's first and terminal assistant messages both stay visible; only the middle folds. **Conflict** — see below.                                                             |
| CS-23 | `#7906` `6e9c57f7b`                      | adopted                   | `622b8c0af`              | Appearance contrast control, 50–200%. Adds 82 `--contrast-*` variables as an indirection over the theme tokens — see below.                                                    |
| CS-24 | `#7937` `4e00471d1`                      | adopted                   | `43b33c759`              | Codex `interacted` no longer re-marks a settled child as running, so completed threads stop showing "working".                                                                 |
| CS-25 | `#7761` `4e169df1d`                      | adopted                   | `6409ff619`              | Duplicate provider-update progress.                                                                                                                                            |
| CS-26 | `#7078` `30be31195`                      | adopted                   | `b29a20c0e`              | Base branch falls back to the remote's recorded default instead of assuming `main`. Pylon's own default branch is `pylon`, so this repository is squarely in the failing case. |

**CS-12 landed as plumbing only, by explicit developer decision.** `#7774` ships two
separable things: origin metadata (client surface and app version stamped onto auth sessions
and orchestration event metadata) and three PostHog events — `client.connected`,
`client.thread.started`, `client.turn.requested`. Pylon's `AnalyticsService` still defaults
`T3CODE_POSTHOG_KEY` to **T3's** project key with telemetry enabled, so adopting the events
as written would have reported every Pylon user's thread and turn activity into T3's
analytics project. The metadata was kept and the three `analytics.record` calls dropped,
along with the now-unused `clientOriginAnalyticsProps` helper, the service acquisition, and
its import. Upstream's analytics test in `server.test.ts` was replaced with one covering what
Pylon retains — that `clientSurface`/`clientAppVersion` on the `/ws` URL reach the dispatched
command's origin, and that a client announcing nothing yields `undefined` rather than a
manufactured empty origin. `OrchestrationEngine.test.ts`'s origin-stamping test was kept
verbatim. The inherited PostHog key is a pre-existing condition this batch did not create and
deliberately did not widen; it deserves its own PR.

**CS-12 also collided on migration ids.** Upstream's `041_AuthSessionClientConnection` lands
on Pylon's existing `041_ProjectionProjectsDefaultThreadEnvMode`. Pylon runs 41 through 44,
so it was renumbered to **045**, matching the precedent set for 037–040. The migration file,
its test file, and the test's `layer(...)` label were all renamed.

**CS-7 is the one place upstream's version replaced working Pylon code.** Pylon had already
fixed the empty-composer hijack inline, with a comment explaining that an empty
contenteditable is still a typing context. Upstream's `#7794` extracts the same rule into an
exported `surfaceShortcutTargetsTypingContext` whose selector is strictly more precise: the
`:not([contenteditable="false"])` clause lets `closest` walk past a non-editable island to an
editable host, where Pylon's `closest("[contenteditable]")` would stop at the island and
suppress the shortcut. Upstream's comment carries the same reasoning Pylon's did, so nothing
was lost by taking it, and the shared helper reduces future divergence.

Conflicts, all resolved Pylon-first:

| File                                                       | Conflict                                                                                                                | Resolution                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChatComposer.tsx`                                         | Pylon's four session-queue callbacks sit where `#7821` adds `intent` to `onSend`                                        | Both kept. Edited byte-wise: the file holds NUL bytes that make `grep` treat it as binary without `-a`.                                                                                                    |
| `ChatView.tsx`                                             | `#7821`'s background-submission tracking wraps a `startThreadTurn` call Pylon had already split into a follow-up branch | `backgroundThreadRef` hoisted above Pylon's branch, since code below the conflict already referenced it. Safe because `background` requires `isLocalDraftThread`, which has no running turn to queue onto. |
| `RightPanelTabs.tsx`                                       | Pylon's independent fix for the same bug                                                                                | Took upstream's helper on merit — see CS-7 above.                                                                                                                                                          |
| `Migrations.ts`                                            | Upstream's new `041` against Pylon's `041`–`044`                                                                        | Renumbered to `045` with a comment recording why, matching the 037–040 precedent.                                                                                                                          |
| `threadActivity.ts`                                        | `#7723`'s first-assistant exemption lands in the same fold loop as Pylon's `terminalResponseNotice` exemption           | Both guards kept; they compose.                                                                                                                                                                            |
| `threadActivity.test.ts`, `MessagesTimeline.logic.test.ts` | Git interleaved two unrelated tests that occupy the same lines                                                          | Rebuilt both files from their sources rather than untangling the interleave: upstream's four edits reapplied to the shared test, upstream's new test inserted beside Pylon's, all tests preserved.         |

Three defects that upstream's own CI would not have caught, because they only exist where
Pylon has diverged. All three were found by reading verification output rather than trusting
exit codes, and are fixed in `4626ce462`:

- `#7821` inserts `submissionIntent` as `onSend`'s **second** parameter. Pylon already had
  `directAnnotation` and `delivery` in positions 2 and 3, so Pylon's own `onQueueFollowUp`
  caller silently passed `"follow-up"` into `directAnnotation`. `tsgo` reported this while
  still exiting 0.
- `#7897` reads `props.selectedThreadQueueCount` on `ThreadDetailScreen`. Pylon calls the same
  value `localOutboxCount`; both are fed from `composer.selectedThreadQueueCount` at the route,
  so only the name differs.
- `#7774`'s migration test pinned upstream's ids — migrate to 40, then to 41. Under Pylon's
  renumbering the columns are added at 45, so against upstream's ids the assertions ran
  against a table that never gained them.

Validation:

- **2221 tests pass** across the touched suites: 766 web, 1062 server (including
  `server.test.ts`), 393 across mobile, client-runtime, shared, contracts, ssh, and tailscale.
  Zero failures in this worktree.
- Every run also globs the nested worktrees under `.claude/`, `.prime/`, and `.superconductor/`,
  which fail to collect for want of their own `node_modules`. Every reported failure was
  confirmed to carry a `worktrees` path segment before the run was accepted. This is a
  pre-existing vitest discovery quirk, not a defect in this batch.
- Typecheck clean across all seven touched packages, each confirmed to have actually run.
  Remaining server diagnostics are pre-existing Effect `suggestion` hints in files this batch
  never touched.
- `vp check` over all 139 changed TypeScript files: **0 errors, 3 warnings**, none introduced
  here. `core.ts`'s `new Array(count)` is `#7809` verbatim; `contextMenuFallback.test.ts`'s
  `no-this-alias` is identical in Pylon and upstream; `MessagesTimeline.tsx`'s dead
  `workEntryIndicatesToolFailure` import is Pylon-only and predates this batch.
- A stale pnpm hard copy of the local `t3-markdown-text` module masked `#6433`'s new exports
  until `vp i` relinked it. Local-environment only; a clean CI install is unaffected.

Not done, and deliberately: no real-client pass in web or mobile. `#6433`/`#7940` change iOS
native markdown rendering and `#7906` restyles the token layer, so both warrant a look in a
running client before release.

## 2026-08-24 — `30be31195883635aba96031a8d79c255fb28b438..f035a0f4cdf4abaa6704673af7b5a4a321149ba2`

Forty-one upstream commits. **Thirty-seven adopted** onto `upstream/2026-08-24-batch`, **four
skipped**. `git cherry` reported every one absent from Pylon. The read-only `git merge-tree`
probe predicted fifteen conflicts; several resolved themselves once earlier commits landed.
The register was empty going in and is empty coming out.

The developer's standing instruction for this batch was to stay in step with upstream unless
a change makes no sense for Pylon, and to adopt rather than defer work that is merely hard.
Two of the four skips were decided by the developer up front; the other two were found during
integration and are argued below.

**Erratum: four `cherry picked from commit` trailers are wrong.** The trailers on `efde49559`,
`8a3ecd827`, `724dbb4ec`, and `ccdeeec09` carry 40-character SHAs that do not resolve; only their
first nine characters match the real upstream commits. The `Upstream` column below is correct and
is the authoritative provenance record for this batch — prefer it over any commit trailer. The
real commits are `6a2608292dd7ba01516112c276e475e6b64e4e2c` (CS-35),
`e9f50c3efcb02a199042364ead292e164274e716` (CS-23),
`7c6163c67aa122fa7c13466536c012888db102c6` (CS-22), and
`25dcee00a6e12db2781a17b326e6e34de0d4ced7` (CS-7). The trailers were left unrewritten rather than
force-pushing a rewrite of all 37 commits on an open pull request.

| ID    | Upstream            | Decision                  | Pylon commit | Notes                                                                                                                                                                         |
| ----- | ------------------- | ------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CS-1  | `#7913` `fdd1572b6` | adopted                   | `00ff9c0cf`  | Sidebar project menu row padding.                                                                                                                                             |
| CS-2  | `#7953` `afa830980` | adopted                   | `5eafdf203`  | Clients reconnect after credentials fail during a remote server update.                                                                                                       |
| CS-3  | `#7949` `3db38b881` | adopted (with adaptation) | `7490b2ce4`  | Codex `/feedback` uploads the thread to OpenAI. 36 files, 18 conflict hunks. Doc reworded off "T3 Code" — see below.                                                          |
| CS-4  | `#5891` `4d12e5222` | adopted                   | `72950957c`  | Stop kills no longer leave Claude work running.                                                                                                                               |
| CS-5  | `#7970` `2433f4c1c` | **skipped**               | —            | One line in `.macroscope/approvability.md`. Pylon has no such file and no Macroscope in CI — see below.                                                                       |
| CS-6  | `#7969` `f70eeeeb0` | adopted                   | `a4dab0fcc`  | Settled pinned threads move into the settled section.                                                                                                                         |
| CS-7  | `#7975` `25dcee00a` | adopted (with adaptation) | `ccdeeec09`  | Release build and Windows packaging speedups. Pylon's `PUBLISH_CLI_TO_NPM` opt-in gate kept alongside upstream's new `quality` dependency.                                    |
| CS-8  | `#7971` `ea8c9e5ca` | adopted                   | `bfbd6ba59`  | Tool calls no longer leave a blank page mid-thread.                                                                                                                           |
| CS-9  | `#7999` `b1670ac7d` | adopted                   | `6576f1d5d`  | Recovered tool failures stop marking work logs red — refines the split documented in PR #69; see below.                                                                       |
| CS-10 | `#7942` `55c909334` | adopted                   | `107af7ca5`  | Mobile markdown image requests isolate per thread.                                                                                                                            |
| CS-11 | `#8009` `9da0fab08` | adopted (with adaptation) | `cb7e0f2c6`  | Skills redesign in the `$` and `/` menus. Pylon already carries `planModeEnabled`, so only `showSkillsInSlashMenu` was taken from the shared settings hunks.                  |
| CS-12 | `#8016` `09df91f72` | adopted                   | `b5a8569e3`  | Right panel toggle clicks work again after closing on desktop.                                                                                                                |
| CS-13 | `#8000` `5427ca056` | adopted                   | `b524949f5`  | Server update banners sit flush with the composer.                                                                                                                            |
| CS-14 | `#8006` `fa219001d` | adopted                   | `b49ad7918`  | Work log rows are reused while streaming.                                                                                                                                     |
| CS-15 | `#7968` `a9cd94eb9` | adopted                   | `330a6ebca`  | Provider badge legibility in dark themes.                                                                                                                                     |
| CS-16 | `#8005` `69e5ad884` | adopted                   | `d8a3271f1`  | Uppercase URL schemes count as secure.                                                                                                                                        |
| CS-17 | `#6412` `b4be33f07` | adopted                   | `6fab4907c`  | Release notes stay visible while downloading.                                                                                                                                 |
| CS-18 | `#7563` `17dbe8dda` | adopted                   | `88a99be16`  | Usage views list only providers with usage. Upstream's `activeProviders` covers seven call sites where Pylon had fixed one inline; Pylon's rationale moved to the definition. |
| CS-19 | `#8052` `643daa516` | adopted                   | `2948657d9`  | Expanded tool calls stop hiding thread content.                                                                                                                               |
| CS-20 | `#8056` `b60a2c0b9` | adopted                   | `55d106abb`  | Removes two no-op live-activity tests Pylon adopted the day before. Verified independently — see below.                                                                       |
| CS-21 | `#7967` `10626c537` | adopted                   | `52f3452bf`  | Terminal sidebar grouping.                                                                                                                                                    |
| CS-22 | `#8058` `7c6163c67` | adopted (with adaptation) | `724dbb4ec`  | Codex app-access approval prompts. **Closed an import cycle in Pylon** — see below.                                                                                           |
| CS-23 | `#8048` `e9f50c3ef` | adopted (with adaptation) | `8a3ecd827`  | Image attachments upload before sending. Pylon's follow-up queue command needed the same widening — see below.                                                                |
| CS-24 | `#7675` `58ba55944` | adopted                   | `a9b799ce5`  | OpenCode skill discovery output is bounded.                                                                                                                                   |
| CS-25 | `#5152` `9eba1252c` | adopted                   | `2015220d0`  | Mobile thread shelf collapse state persists.                                                                                                                                  |
| CS-26 | `#5385` `2d2efff28` | adopted                   | `bd6b176af`  | Android tablet thread controls restored.                                                                                                                                      |
| CS-27 | `#5585` `f9a726e62` | adopted                   | `811768e05`  | First thread open lands above the composer on Android.                                                                                                                        |
| CS-28 | `#7674` `be3da50e9` | adopted                   | `d6e261bf5`  | Submodules are checked out in a new worktree.                                                                                                                                 |
| CS-29 | `#6216` `ba30177b5` | **skipped**               | —            | Merged PR badges after branch deletion. **Pylon already solved this and upstream's version regresses it** — see below.                                                        |
| CS-30 | `#6472` `229b05df0` | adopted                   | `eae8524d3`  | Live pull request reads are fresh.                                                                                                                                            |
| CS-31 | `#7579` `6f5c951a4` | adopted (with adaptation) | `d29878267`  | Semver comparison for client/server skew. Upstream's new `MISMATCH_HINT` constant said "T3 Code version"; kept Pylon's wording.                                               |
| CS-32 | `#8068` `c0047c252` | adopted                   | `996207b53`  | Follow-ups stop leaving giant blank space (legendapp patch + lockfile).                                                                                                       |
| CS-33 | `#8070` `e31e568bd` | **skipped**               | —            | Disables automatic Vercel deployments on pull requests. **Pylon deliberately enabled them** — see below.                                                                      |
| CS-34 | `#8071` `a00218741` | **skipped**               | —            | Vouches repeat contributors. `.github/VOUCHED.td` is fork governance; Pylon's list diverges by 5 insertions / 32 deletions. Same call as `#7728` last batch.                  |
| CS-35 | `#7583` `6a2608292` | adopted (with adaptation) | `efde49559`  | Authoritative subagent model when snapshots race `task_started`. Both forks add a different fallback to one chain — see below.                                                |
| CS-36 | `#7100` `04df98db4` | adopted                   | `bd49ff34a`  | Auto-accept edits honored for OpenCode.                                                                                                                                       |
| CS-37 | `#7141` `3fd506433` | adopted                   | `2e46f909c`  | CLI runs on Node versions without `import.meta.main`. Its test needed a macOS fixture fix — see below.                                                                        |
| CS-38 | `#7412` `17822fab7` | adopted                   | `82c2354ff`  | Provider interrupt failures recover.                                                                                                                                          |
| CS-39 | `#7839` `01fc7d228` | adopted                   | `abb9040fd`  | A thread's worktree is recreated before starting a turn.                                                                                                                      |
| CS-40 | `#8076` `e6a109b9f` | adopted                   | `9b094b4c3`  | Thread delete no longer fails on an already-removed worktree.                                                                                                                 |
| CS-41 | `#8083` `f035a0f4c` | adopted                   | `8ac255d3e`  | Update notices stop showing through the composer.                                                                                                                             |

**CS-20 was verified rather than trusted.** `#8056` deletes two tests Pylon adopted the day
before in `#7893`, calling them no-ops. Both halves of upstream's argument check out
independently: each test supplies exactly one activity, and both filters keep a singleton —
`dropStaleContextWindowActivities` maps the lone activity's turn to index 0 and keeps index 0,
and `dropSupersededToolUpdatedActivities` returns early when no completion exists. So they pass
whether or not the filters are wrongly applied to live events. The coverage upstream names as
the replacement is present in Pylon and does exercise `projectActivityEvent`.

**CS-9 refines PR #69's finding, and upstream got there too.** #69 documented why the two
`work-toggle` producers use different failure predicates. `#7999` says the earlier fix "covered
tool-only groups but missed mixed work logs" and lands the better answer: the overflow toggle
now requires _both_ that a hidden entry failed and that the group's latest tool entry still
shows failure. That is the conjunction of the two concerns, not a replacement for either. The
comment at that site was rewritten accordingly.

**CS-22 closed a runtime import cycle that only exists in Pylon.** Upstream has
`providerRuntime.ts` import `ProviderApprovalOption` from `orchestration.ts` — a one-way edge
for them. Pylon's `orchestration.ts` already imports `providerRuntime.ts` for its session
payloads, so that edge closes a cycle: `Schema.Array(ProviderApprovalOption)` evaluated
`undefined` at module init and the approval suite failed to collect. Typecheck hoists the types
and never sees it. `ProviderApprovalDecision` and `ProviderApprovalOption` moved to
`baseSchemas.ts`, a leaf both files already import. The decision union also gains upstream's new
`"acceptAlways"` literal, which arrived in `7c6163c67` and which the first move dropped.

**CS-23 needed Pylon's follow-up queue widened to match.** `thread.input-queue.follow-up` is
Pylon-only and shares the composer with `thread.turn.start`, so it takes the same widened
attachment union upstream applied to turn-start. The server-side normalizer already branches on
`"dataUrl" in attachment` for both commands, so nothing else was required.
`cleanupFailedUploadedAttachments` was extended to the follow-up command too: both claim
uploaded copies during normalization, so both leak them on a failed dispatch. Upstream only
guards turn-start because it has no such command.

**CS-23 also tried to reinstate analytics the last batch removed.** Its `ws.ts` hunk carries
both the attachment cleanup and `recordClientCommandAnalytics`, which the 2026-08-23 batch
deliberately dropped when `#7774` landed as plumbing only. The cleanup was taken; the analytics
call was not.

**CS-29 is skipped because Pylon already shipped this fix and upstream's regresses it.**
`#6216` preserves a merged PR badge after the remote branch is deleted and pruned. Pylon already
implements exactly that, with its own `skipped` mechanism, and already carries the same test —
which passes on clean `pylon`. Upstream's version changes `isUnpublishedBranch` to treat
configured branch upstream metadata as proof of publication; applied on top of Pylon's
machinery it makes the lookup fire again and blanks the cached badge. Isolated to be sure:
cherry-picked alone onto clean `origin/pylon`, the test fails. With `#6216` dropped,
`GitManager.test.ts` is 246/246.

**CS-33 is skipped because it reverses a deliberate Pylon decision.** `#8070` adds
`git: { deploymentEnabled: false }` to `apps/marketing/vercel.ts`. Pylon already sets
`deploymentEnabled: true` there, with a comment recording that deployments were held off only
while the site carried T3's product copy and legal pages, and enabled once that copy was gone.
The cherry-pick produced a duplicate `git:` key — the later one wins, so behavior was
accidentally unchanged and only the linter caught it. AGENTS.md resolves conflicts Pylon-first
and prefers the later Pylon-specific product decision.

**CS-5 is skipped because it configures a bot Pylon does not run.** `.macroscope/approvability.md`
does not exist in Pylon and no workflow references Macroscope. Adopting would create the file
solely to configure something that never executes.

**CS-3's user doc was reworded.** `docs/user/providers-codex.md` arrived saying "T3 Code uploads
the thread and Codex logs to OpenAI". `docs/user/` is shipped-product voice, so that reads
"Pylon". The feature itself is opt-in per invocation — the user types `/feedback` — and it does
upload the thread and Codex logs to OpenAI, which the doc states plainly.

**CS-37's test could not pass on macOS.** `#7141`'s fixture builds `moduleUrl` from an
unresolved temp path while the implementation realpaths `process.argv[1]`. On macOS
`os.tmpdir()` sits under the `/var` → `/private/var` symlink, so `realpathSync` resolves the
prefix as well as the entry link and the two never match. Node hands `import.meta.url` over
fully resolved, so resolving the fixture root is what actually mirrors the runtime. Fixed in
`a178bd116`; green on Linux CI either way, red on every macOS checkout without it.

Conflicts of note, all resolved Pylon-first:

| File                           | Conflict                                                                                                | Resolution                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChatComposer.tsx` (`#8058`)   | A 50-vs-76 line conflict from Pylon's fragment wrapper and its two-space indent shift                   | Upstream's real change to this file is **two lines** — an `options` prop on two call sites. Applied directly; the rest was git noise.                           |
| `ChatComposer.tsx` (`#8048`)   | git aligned Pylon's collapsed-mobile row and bottom toolbar against upstream's stash menu and image map | Unrelated regions. Pylon's tree kept; upstream's two real changes applied at Pylon's own sites.                                                                 |
| `use-thread-composer-state.ts` | Seven hunks, mostly import reordering plus a rewritten `selectedThreadFeed`                             | Pylon's imports are a superset; upstream's feedback symbols added beside them. `onSendMessage` deps unioned.                                                    |
| `ClaudeAdapter.ts` (`#7583`)   | Both forks add a fallback to the same `model` chain                                                     | Merged to `bufferedModel ?? launchInput?.model ?? previousAgent?.model ?? session.model` — upstream's ordering, Pylon's arm below the explicit launch override. |
| `ClaudeAdapter.test.ts`        | Upstream's purely additive test anchored inside Pylon's own resume test and interleaved them            | Inserted as a whole block at the test boundary. Both tests present; suite passes 207.                                                                           |
| `release.yml`                  | Pylon's `PUBLISH_CLI_TO_NPM` opt-in against upstream's new `quality` dependency                         | Both kept.                                                                                                                                                      |
| `versionSkew.test.ts`          | Upstream's new `MISMATCH_HINT` constant carries T3 branding                                             | Constant adopted, wording kept Pylon's.                                                                                                                         |

Two duplicate imports survived a clean git merge and were caught by typecheck, not by the
merge: `WS_METHODS` in `threadCommands.ts` and `ProviderService` in `server.test.ts`.

Validation:

- **3309 tests pass** across the 58 touched test files. The one failure in this worktree,
  `build-desktop-artifact > skips the primary native probe for cross-architecture Windows
payloads`, is **pre-existing on `origin/pylon`** and host-arch dependent: the test passes
  `targetArch: "arm64"`, which is not cross-architecture on an Apple Silicon machine, so the
  probe legitimately runs. Verified by running it against an untouched `origin/pylon` checkout.
- Every run also globs the nested worktrees under `.claude/`, `.prime/`, and `.superconductor/`,
  which fail to collect for want of their own `node_modules`. Every reported failure was
  confirmed to carry a `worktrees` path segment before the run was accepted.
- Typecheck clean across all seven touched packages, each confirmed to have run.
- `vp check` over 153 changed TypeScript files: **0 errors, 1 warning**, and that warning is
  upstream-verbatim (`for (const pending of [...map.values()])` in `ClaudeAdapter.ts`).
- `vp i` was re-run after `#8068` changed a patch file and the lockfile.

Not done, and deliberately: no real-client pass in web or mobile. `#8009` redesigns the slash
and `$` menus, `#8048` changes composer attachment UI, and `#8058` changes approval prompts on
both clients; all three warrant a look in a running client before release.

## 2026-08-25 — `f035a0f4cdf4abaa6704673af7b5a4a321149ba2..bd9ed2b4bbda3dd6e468df1cb06233e29c4a9f5c`

Twelve upstream commits grouped into ten change sets. The developer approved the full batch. Nine
sets produced source changes on `upstream/2026-08-25-bd9ed2-batch`; A6 was already present in
Pylon, so its cherry-pick was correctly empty. The deferred register was empty going in and remains
empty.

Pylon-first reconciliation was required in three places. A5's projection optimization now preserves
full shell-summary refreshes for Pylon's `interaction.requested`, `interaction.resolved`, and
`provider.interaction.respond.failed` activities, with a request/resolution regression test. A8
keeps Pylon's application ids, protocols, product/artifact names, local ad-hoc signing, and optional
passkey setup while enabling upstream's batched signed-build hook. A9's upstream migration 042 was
renumbered to **046** because Pylon already owns 042 through 045; using 042 would silently skip the
linked-PR column on existing Pylon databases.

| ID  | Upstream                                    | Decision                  | Pylon reference          | Notes                                                                                                                                                 |
| --- | ------------------------------------------- | ------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `5f1147cad` / `#8124`                       | adopted                   | `0875df643`              | Nightly-to-nightly skew compares the full date/run while stable/nightly compatibility remains core-version based. Pylon wording retained.             |
| A2  | `8287f2c3a`, `a1379db81` / `#8111`, `#8108` | adopted                   | `adc19dbec`, `f4608a35c` | Usage skeleton matches the loaded layout and model rows follow the selected cost/token metric. Pylon's active-provider rationale retained.            |
| A3  | `883e1a3cd` / `#7488`                       | adopted                   | `79b4bec99`              | Terminal links show hover affordance only with the activation modifier; uppercase URL schemes also activate correctly.                                |
| A4  | `a09f92171`, `99960383d` / `#8081`, `#8098` | adopted                   | `2b7f2e6be`, `f7e8c7522` | Windows, spaced, HTML, and XML agent file links reach the integrated viewer on the applicable web/mobile surfaces. Unsafe schemes remain rejected.    |
| A5  | `c034f51bb` / `#8150`                       | adopted with adaptation   | `c21a6c05b`, `0f99d52af` | Routine assistant/tool events stop rescanning full histories. Pylon interaction activities remain summary-changing.                                   |
| A6  | `2394998aa` / `#8163`                       | adopted (already present) | `877dad32a`              | Both `@xmldom/xmldom` deprecation records already existed; the upstream cherry-pick was empty and skipped.                                            |
| A7  | `143341b0b` / `#8089`                       | adopted                   | `92bbc7ccf`              | Configurable `mod+shift+s` settles or restores the active thread and stays inactive in the terminal.                                                  |
| A8  | `63eb0429f` / `#8093`                       | adopted with adaptation   | `d6a20af51`              | Batches macOS codesign calls, trims staged dependencies, and excludes Windows terminal binaries without crossing Pylon's desktop identity boundaries. |
| A9  | `3c75eb113` / `#8160`                       | adopted with adaptation   | `ddc4cfb50`              | Persisted PR-to-thread linking across server, contracts, web, and mobile. Migration renumbered 042 → 046.                                             |
| A10 | `bd9ed2b4b` / `#8161`                       | adopted                   | `21a40af90`              | Web/desktop HEIC and HEIF attachments convert to guarded JPEG through a lazy `heic-to` decoder.                                                       |

Focused validation before ledger commit: 516 changed-behavior tests pass (285 web, 73 server, 87
contracts/client-runtime, 56 mobile, 15 version-skew), plus the macOS signing test. All seven
affected package typechecks pass. Lint reports 0 errors and two pre-existing `prefer-set-has`
warnings in an untouched part of `ProjectionSnapshotQuery.test.ts`; formatting is clean over all 70
changed source/doc/config files. `build-desktop-artifact.test.ts` has one pre-existing host-dependent
failure on Apple Silicon: its alleged cross-architecture fixture is arm64, so the native probe runs;
the same assertion fails on clean `pylon`.

No real-client pass ran during integration. Web/mobile UI verification still requires explicit
computer-use permission.

### Post-integration review

The final rebased branch received a separate source-level review after integration. A fresh fetch
confirmed that upstream `main` still ends at `bd9ed2b4`, so no commit appeared after the original
review. Patch coverage includes every upstream-touched file; the only path differences are the two
A9 migration files deliberately renamed from 042 to 046. A zero-context added-line scan found no T3
product name, app id, renderer protocol, artifact name, or hosted-origin drift. The migration
manifest is unique and ordered through 046. The Pylon-specific Prime activity kinds used to derive
pending input are a subset of the optimized refresh allowlist. Contracts, capability gating,
server projection and persistence, web, mobile, reverse actions, connection modes, and user docs
were each checked with no confirmed cross-surface omission.

A production web build also passed. It confirms that `heic-to/csp` resolves and remains a separate
lazy chunk, so HEIC support does not increase the initial bundle. Two risks remain visible for
maintainer review: that decoder chunk is 2.995 MB minified / 751 KB gzip on first use, and
`heic-to@1.5.2` declares LGPL-3.0 while Pylon has no artifact-level third-party notice flow. The
known Apple Silicon packaging-test baseline failure remains unrelated. Real-client screenshots and
manual interaction checks were not run because browser/computer-use permission was requested but
not granted.

## Deferred register

_DEF-1 and DEF-2 were adopted on 2026-08-11
(see the sixth batch above). DEF-3 and DEF-4 were opened and closed on
2026-08-18: the 2026-08-18 batch review found them, the batch shipped without
them so the adoption stayed faithful, and `fix/pull-request-quota-followups`
fixed both the same day. DEF-6 was opened 2026-08-21 and adopted the same
day, once `#7725` reconciled the tests it was blocked on. The 2026-08-24 batch
opened no new entries either; 2026-08-27 opened DEF-7, which the second and third 2026-08-27 batches
re-checked and left open, as did 2026-08-28 — no upstream commit in that range
touched `desktop-macos-preview.yml`, and its 2026-11-01 floor is unreached. The
2026-08-28 batch opened no new entries: the developer adopted every candidate
that was not skipped outright, so nothing was left pending. The 2026-08-23 batch
opened no new entries and left it empty; it did retire the dead `U-4326`
revisit condition recorded in the 2026-08-04 table, since that pull request
closed unmerged. The 2026-08-29 batch re-checked DEF-7 and left it open — no
commit in `f94a0d646..1f8ed54ad` touched `desktop-macos-preview.yml`, and its
2026-11-01 floor is still unreached — and opened DEF-8 and DEF-9. The 2026-09-01
batch retired DEF-9 — `#8693` was adopted as `#221`, once the review established
that `#8734`, not `#8693`, is the correct base — re-checked DEF-7 and left it
open (nothing touched `desktop-macos-preview.yml`, and its 2026-11-01 floor is
unreached), and re-checked DEF-8: its blocking condition **has now cleared**,
since Expo SDK 57 merged as `eff44d0cf`, leaving only its 2026-09-05 floor. That
batch also opened DEF-10 — approved work that was never started, recorded
because it sat before the cursor where no commit range would have surfaced it
again. It was adopted as `#235` and retired the same day, 2026-09-01; the
register did exactly its job, which was to stop it vanishing between sessions.
Entries are removed once adopted, skipped, or fixed._

Upstream work that has been reviewed and consciously _not_ adopted yet, with
the condition that should trigger a fresh look. Entries stay here until they
are adopted or skipped outright — a deferral that nobody revisits is the same
as losing it.

Every review must read this register before reporting new candidates,
re-evaluate each `Revisit when` against the current upstream head, and report
the outcome. See Phase 2.5 of the `review-t3-upstream` skill.

| ID    | Upstream                                                                | Deferred on | Revisit when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Why deferred                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | ----------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEF-7 | `33b650a5b` / `#8243` — anonymous macOS preview DMG downloads           | 2026-08-27  | Either premise changes. (a) Pylon decides to distribute unsigned preview builds publicly — an external tester programme, or a contributor who cannot use `gh run download`. (b) Upstream lifts the same-repo restriction or drops the `contents: write` publish job: check with `git log --oneline <cursor>..t3code-upstream/main -- .github/workflows/desktop-macos-preview.yml` and read any hit touching the `if:` guards or job permissions. Not before 2026-11-01 — neither premise moves on a weekly timescale, and this should not be re-litigated every review.                                                                                                    | Adopted as `#111`, then reverted by `#113` the same day. The port was sound and its four review findings were fixed; the feature does not earn its cost here. Fork PRs cannot trigger it, `gh run download` covers the headless case, and Pylon Nightly covers merged builds — leaving one maintainer-only use against 210 lines of race-prone YAML, a `contents: write` token on a PR-triggered workflow, a publicly hosted unsigned binary, and a Releases widget on a repository that otherwise has none. If revived, start from `#111` plus the fixes in `9d112329e`, not from upstream. |
| DEF-8 | `1f8ed54ad` / `#8694` — mobile dev-client reload and Metro startup cost | 2026-08-29  | `#171` (Expo SDK 57) has merged: `git log --oneline origin/pylon --grep "Expo SDK 57"` returns a commit. Then split it: the dev-loop half (`--clear` removal, dev `appVersion` runtime policy, uniwind 1.11 plus its patch, hot-swappable atom runtime, fast-refresh hooks, docs) and the product half (ControlPill long-press with the `@react-native-menu/menu` native patch, `home-thread-navigation`, `remote-environment-projections`, and the `client-runtime` `connection/registry.ts` scope change that also affects web). Drop upstream's `AGENTS.md` and `test-t3-mobile` skill hunks; keep the `pylon-code-*` schemes in `package.json`. Not before 2026-09-05. | Its lockfile was generated on Expo 57 and RN 0.86 and only verified there; on `pylon` today it conflicts on `pnpm-workspace.yaml` (4.25.2 versus the 4.26.2 screens patch), `apps/mobile/package.json` scheme identity, the lock, and Pylon-owned docs. Both halves need a native rebuild. Reviewed 2026-08-29; not a fit to land ahead of the SDK upgrade it was built on.                                                                                                                                                                                                                  |

## Upstream watch list

Upstream work Pylon is tracking that has **never entered a review range** —
open issues, unmerged pull requests, and capabilities Pylon expects upstream to
attempt. The deferred register above holds change sets that were candidates in
some batch and were consciously not adopted; those entries carry an upstream
SHA and end in adopt or skip. Watch entries have no SHA and may never land.
They are here because the `<cursor>..t3code-upstream/main` range cannot surface
them: a pull request that never merges produces no commit for a review to find.

Every review must read this list alongside the deferred register, re-evaluate
each `Revisit when` against current upstream state, and report the outcome. See
Phase 2.5 of the `review-t3-upstream` skill.

**Entries can be owned by a Pylon issue.** The `Owner` column names the issue
that holds the design context and the response Pylon intends to evaluate. When
an entry comes due, is rewritten, or is retired, update the owning issue in the
same change. An owner that disagrees with this table is the failure this list
exists to prevent.

| ID      | Owner                                                                                                                                                         | Upstream                                                                                                                                         | Added      | Current signal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Revisit when                                                                                                                                                                                                                                                                                                                                                                                                                       | Response to evaluate                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WATCH-1 | [`#114`](https://github.com/pylon-code/pylon/issues/114) — Prime provider parity                                                                              | `#5760` (issue, open) OpenCode `todowrite` updates do not reach the task sidebar; `#8097` (PR, open draft) restore composer tasks after relaunch | 2026-08-29 | `#5760` is a real defect **present in Pylon**: `OpenCodeAdapter.ts` emits no `turn.plan.updated`, so the composer Tasks tab, inline plan chip, and sidebar working line are dead on OpenCode, and every `todowrite` is misclassified `file_change` and inflates the edit count. Pylon is fixing this itself against the v2 SDK's structured `todo.updated` event; there is no upstream patch to take. That Pylon-side fix is open as [`#178`](https://github.com/pylon-code/pylon/pull/178) (`fix/opencode-plan-parity`), so `#5760` stays listed only because the upstream issue is still open. **`#8097` is superseded** — Pylon shipped the same fix in `#137` (`8698a69e`) before the draft opened, via the `latest_plan_activity` CTE in `ProjectionSnapshotQuery.ts`, and with waiting-step retention the draft's settled-turn gate would regress. | For `#5760`: nothing to watch upstream — Pylon owns the fix. For `#8097`: only if it merges AND diverges from Pylon's approach. Check `gh pr view 8097 --repo pingdotgg/t3code --json state,mergedAt`. Its migration id 42 is unusable here (Pylon's 42 is `ProjectionProjectFaviconPath`; the manifest runs through 47, so any new migration is 048). Upstream's own trunk has a 42 collision between `#8097` and merged `#8160`. | Do not port `#8097`. Two fragments stand alone on their merits: its partial plan-activity index as a Pylon-numbered `048`, but only if `EXPLAIN QUERY PLAN` shows Pylon's CTE actually reverse-scans; and a Pylon-voiced Tasks section for `docs/user/composer.md`, which has none today. Its `turn.aborted` reducer hunks are an unrelated concern — investigate separately, do not smuggle them in. |
| WATCH-2 | [`#174`](https://github.com/pylon-code/pylon/issues/174) — cross-thread messaging design; context in [`#114`](https://github.com/pylon-code/pylon/issues/114) | `#6573` (PR) — authenticated cross-thread MCP tools                                                                                              | 2026-08-29 | **Premise gone.** Closed unmerged 2026-08-28 without adding permission splitting or bounded read-only tools. Nothing upstream to compare against today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | A replacement lands. Check `git log --oneline <cursor>..t3code-upstream/main -- apps/server/src/mcp/toolkits/` and `gh pr list --repo pingdotgg/t3code --search 'mcp thread tools' --state merged`. Not before 2026-11-01 — upstream abandoned this once and a rewrite is not a weekly event.                                                                                                                                      | Compare with Pylon's scoped read-only context/checkpoint MCP design before adoption. Do not revive `#6573` itself.                                                                                                                                                                                                                                                                                    |
| WATCH-3 | [`#177`](https://github.com/pylon-code/pylon/issues/177) — scheduled-run safety contract; context in [`#114`](https://github.com/pylon-code/pylon/issues/114) | `#7966` (issue) / `#7986` (PR) — server-side scheduled agent runs                                                                                | 2026-08-29 | **Premise gone.** Both closed 2026-08-28; `#7986` closed unmerged. The implementation Pylon declined to cherry-pick no longer exists upstream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | A replacement scheduling implementation merges. Check `git log --oneline <cursor>..t3code-upstream/main -- apps/server/src/orchestration/Layers/TaskFireReactor.ts apps/server/src/orchestration/Layers/OrchestrationReactor.ts`. Not before 2026-11-01.                                                                                                                                                                           | Fresh review only. Pylon's own canonical scheduled-turn ownership question in `#114` is unblocked by upstream's retreat, not answered by it.                                                                                                                                                                                                                                                          |
