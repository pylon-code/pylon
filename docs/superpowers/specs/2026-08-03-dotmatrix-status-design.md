# Dotmatrix status indicators

**Date:** 2026-08-03
**Status:** Approved by developer (conversation), pending spec review
**Scope:** Web client (desktop inherits). Mobile, marketing, and button/action spinners are explicitly out of scope.

## Problem

Pylon's working/status animations are a patchwork: pulsing dots in sidebar v1, breathing text in sidebar v2, three staggered dots in the chat timeline, ping halos on connection dots, a pulsing terminal icon, and a pulsing recording badge. Each surface invented its own motion. The developer wants to adopt the 5×5 dot-matrix status language from `~/repos/pylon-orchestrator` (`web/packages/design-system/src/dot-matrix.tsx`) as the single status vocabulary, adapted to Pylon: cleaner dot geometry at small sizes, Pylon's established status hues, and Pylon's compositor-friendly animation discipline.

## Design

### 1. Primitive

New `apps/web/src/components/ui/dot-matrix.tsx`, alongside `spinner.tsx`/`skeleton.tsx`.

- A `role="status"` span with an sr-only label, wrapping an `aria-hidden` SVG (`viewBox="0 0 20 20"`) of 25 circles on a 5×5 grid (pitch 4, centers at 2 + 4·n).
- Dots fill with `currentColor`; the component owns pattern, callers own hue via text color classes.
- Per-dot resting `fillOpacity`; animated states add a CSS opacity blink with per-dot `animationDuration`/`animationDelay` and a `--dot-matrix-blink-lo` custom property for the low point. Static dots carry **no animation timeline**.
- Twinkle-style patterns use the orchestrator's deterministic bit-mixing hash so markup is stable across renders (no `Math.random`).
- Keyframes plus a global `prefers-reduced-motion` freeze live in `apps/web/src/index.css` next to the existing animation tokens.

**Sizing ("cleaner dots").** No `1em` sizing. Callers set explicit sizes: `size-3.5` (14 px) in sidebar rows, banners, and connection dots; `size-4` (16 px) in the chat timeline. Dot radius starts at r=1.4 (in the 20-unit viewBox) so dots stay ≥ 2 device pixels on 2× displays at 14 px; the exact radius gets one visual tuning pass during implementation.

### 2. States

Eleven states, trimmed from the orchestrator's twenty. Each maps a pattern to Pylon's existing hue convention (amber approval, indigo input, sky working — see `SidebarV2.tsx:483`); color always arrives from the call site's existing `colorClass`, never from the component.

| State        | Pattern                          | Animated       | Hue at call sites |
| ------------ | -------------------------------- | -------------- | ----------------- |
| `working`    | row sweep with per-column jitter | yes            | sky               |
| `connecting` | center-out ripple                | yes            | sky               |
| `approval`   | `!` glyph                        | slow blink     | amber             |
| `input`      | `…` glyph                        | gentle stagger | indigo            |
| `plan`       | `i` glyph                        | no             | violet            |
| `done`       | check glyph                      | no             | emerald           |
| `error`      | cross glyph                      | slow blink     | red               |
| `idle`       | full grid, low opacity           | no             | muted             |
| `terminal`   | `>_` prompt glyph                | gentle blink   | teal              |
| `recording`  | record glyph (center cluster)    | slow blink     | red/destructive   |
| `live`       | center-cluster glyph             | slow breathe   | green/success     |

Glyphs are coordinate sets on the 5×5 grid (check, cross, bang, ellipsis, info ported from the orchestrator; the `>_` prompt glyph is new). Off-glyph dots rest at low opacity (~0.12–0.15) so the grid frame stays visible.

### 3. Status mapping

The thread-status→matrix mapping lives in the existing resolvers, not in components:

- `ThreadStatusPill` (`apps/web/src/components/Sidebar.logic.ts`) gains a `matrix: DotMatrixState` field. `colorClass` keeps driving color. `dotClass` and `pulse` are deleted once all consumers migrate — no dual system left behind.
- Mapping: Pending Approval → `approval`, Awaiting Input → `input`, Working → `working`, Connecting → `connecting`, Plan Ready → `plan`, Completed → `done`; sidebar-v2 `failed` → `error`.
- `resolveProjectStatusIndicator` rollup logic is unchanged; it inherits `matrix` through the pill.

### 4. Surfaces changed

1. **Sidebar v1 thread rows + command palette** (`ThreadStatusIndicators.tsx`): both dot variants (compact and full) become a 14 px DotMatrix; tooltip and label behavior unchanged.
2. **Project rollup dot** (`Sidebar.tsx` collapsed project header): same swap; hover cross-fade to chevron preserved.
3. **Sidebar v2** (`SidebarV2.tsx`): `CircleDashedIcon` next to "Working" becomes DotMatrix `working`; the `animate-sidebar-working-text` breathe is removed (the matrix carries the motion; label and live timer sit static). Done → `done` glyph, Failed → `error` glyph. The "Woke" alarm-clock icon stays.
4. **Chat timeline** (`MessagesTimeline.tsx` `WorkingTimelineRow`): the three staggered dots become a 16 px DotMatrix `working` in the sky working hue, next to the existing "Working for …" timer.
5. **Connecting/updating banners** (`ChatView.tsx`): pulsing dots become DotMatrix `connecting`, inheriting banner text color.
6. **Terminal-process indicator** (`ThreadStatusIndicators.tsx`, `Sidebar.tsx`, `SidebarV2.tsx`): the pulsing teal `TerminalIcon` becomes a teal DotMatrix `terminal` glyph; existing tooltip unchanged.
7. **Preview recording badge** (`PreviewChromeRow.tsx`): pulsing red dot → DotMatrix `recording`.
8. **Connection status dots** (`ConnectionStatusDot.tsx` and consumers in `settings/ConnectionsSettings.tsx`, `cloud/CloudEnvironmentConnectList.tsx`, `preview/PreviewLocalServerCard.tsx`): the ping-halo dot becomes a DotMatrix — `live` when connected, `connecting` while connecting, `error` when down. `ConnectionStatusDot` remains a thin wrapper so its tooltip API and call sites barely change.

Untouched: `animate-spin` action spinners, toasts, skeletons, the agent-browser click ripple, mobile (React Native — a Reanimated port is a possible follow-up), marketing, and the one-shot/utility animations in `index.css`.

Old keyframes are removed only when their last consumer migrates; `status-ping` stays (agent-browser cursor still uses it).

### 5. Motion and performance

- **Stepped timing.** Blink keyframes use `steps()` holds (like the existing `status-pulse`/`status-ping`) so the compositor updates a few discrete frames per cycle instead of every vsync — many indicators can be on screen at once. The quantized flicker also reads like a real LED matrix.
- **Animation only where it means something.** Only `working`, `connecting`, `approval`, `input`, `error`, `terminal`, `recording`, and `live` dots have animation timelines; `plan`, `done`, and `idle` are fully static.
- **Reduced motion.** One global `prefers-reduced-motion: reduce` rule freezes all matrix dots at resting opacity; glyphs remain legible. This fixes today's inconsistent reduced-motion coverage on every migrated surface.
- State changes cross-fade per dot via a short `fill-opacity` transition, independent of the blink animation.

### 6. Testing and verification

- `apps/web/src/components/ui/dot-matrix.test.tsx`: state→glyph/animation mapping (animated dots only in animated states, static states have no animation timeline, sr-only label, deterministic markup across renders).
- `Sidebar.logic` tests extended for the `matrix` field on `resolveThreadStatusPill` / v2 status resolution.
- Targeted lint/typecheck for touched files only; no repo-wide checks (CI owns those).
- One integrated visual pass in a real web client at the end (dev server + browser only with the developer's go-ahead, per repo rules).

## Out of scope / follow-ups

- Mobile Reanimated/SVG port of the DotMatrix (mobile thread rows stay static pills).
- Replacing action spinners with a matrix `loading` state.
- Additional orchestrator states (syncing, uploading, listening, …) — add on demand.
