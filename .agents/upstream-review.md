---
remote: t3code-upstream
branch: main
reviewed-through: "c30a6d9b9943cfbf2fd47efc9de6eb9675457d52"
reviewed-through-date: "2026-08-04"
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

## 2026-08-04 — unmerged upstream pull request (cursor unchanged)

Out-of-band review of a single open pull request, adopted ahead of merge at the developer's
request. `reviewed-through` deliberately stays at `c30a6d9b9`: `#4326` is not in
`t3code-upstream/main`, and this session reviewed one pull request rather than a commit range.

| Change set | Upstream             | Decision                  | Pylon reference                                                        | Rationale or revisit condition                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | -------------------- | ------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-4326     | `0abc172d` / `#4326` | adopted (with adaptation) | `upstream/2026-08-04-provider-usage-limits` / `5c28cfc38`, `bf0c025d2` | Subscription usage windows on provider snapshots. Applied as a manual port of the pull request's net diff — the branch sits 84 commits behind upstream main, so its series does not cherry-pick. Pylon adaptations: multi-account popover, and `showProviderUsageInContextPopover` defaulted on. **Revisit when `#4326` merges** — reconcile Pylon's variant against the merged form, which may differ after review. |

For each completed batch, append a section in this form:

```markdown
## YYYY-MM-DD — `<previous-cursor>..<reviewed-head>`

| Change set | Upstream      | Decision                      | Pylon reference        | Rationale or revisit condition |
| ---------- | ------------- | ----------------------------- | ---------------------- | ------------------------------ |
| A1         | `sha` / `#pr` | adopted, skipped, or deferred | branch, commit, or `—` | concise reason                 |
```
