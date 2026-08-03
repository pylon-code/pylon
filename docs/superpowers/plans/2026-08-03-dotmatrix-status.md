# Dotmatrix Status Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Pylon's patchwork of working/status animations with a single 5×5 dot-matrix status primitive, per the approved spec at `docs/superpowers/specs/2026-08-03-dotmatrix-status-design.md`.

**Architecture:** One new `DotMatrix` React component in `apps/web/src/components/ui/` renders a 5×5 SVG circle grid; state patterns (sweeps, ripples, dot-drawn glyphs) are a static config table, animation is per-dot CSS opacity blink with stepped timing, and color always comes from the caller's text class via `currentColor`. Existing status resolvers gain a `matrix` field so every surface derives its pattern from one source.

**Tech Stack:** React 19, Tailwind v4 (`apps/web/src/index.css` plain keyframes), `vite-plus/test` with `renderToStaticMarkup` for component tests, `vp test run <file>` / `vp exec biome check <file>` / targeted tsc via `vp run typecheck` scoping.

## Global Constraints

- Work happens in worktree `.claude/worktrees/dotmatrix-status`, branch `worktree-dotmatrix-status`. Never touch the main checkout.
- No repo-wide checks: run only `vp test run <specific files>` and targeted lint/typecheck. CI owns the full suite.
- Color always arrives from call sites' existing text classes (amber approval, indigo input, sky working, violet plan, emerald done, red failed, teal terminal); the component never hardcodes hues.
- All blink animation uses the stepped duty-cycle discipline (`steps()` holds) like the existing `status-pulse` keyframes.
- Static states must render **no** animation timeline (no `animation-duration` in markup).
- One `prefers-reduced-motion: reduce` rule freezes all matrix dots.
- No AI attribution in commits. Conventional commit format `type(scope): description`.
- Commands run from the worktree root. A pre-commit hook runs `vp fmt` on staged files — if it reformats, the commit still lands; don't fight it.

---

### Task 1: DotMatrix primitive

**Files:**

- Create: `apps/web/src/components/ui/dot-matrix.tsx`
- Modify: `apps/web/src/index.css` (append after the `@theme inline` block, near the other plain keyframes)
- Test: `apps/web/src/components/ui/dot-matrix.test.tsx`

**Interfaces:**

- Consumes: `cn` from `~/lib/utils`.
- Produces: `DotMatrix` component and `DotMatrixState` type (`"working" | "connecting" | "approval" | "input" | "plan" | "done" | "error" | "idle" | "terminal" | "recording" | "live"`). Props: `{ state: DotMatrixState; label?: string } & Omit<React.ComponentProps<"span">, "children">`. Callers size it with `size-*` classes and color it with `text-*` classes via `className`. Later tasks import: `import { DotMatrix, type DotMatrixState } from "./ui/dot-matrix";` (adjust relative path per file).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/ui/dot-matrix.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DotMatrix } from "./dot-matrix";

const countAnimated = (html: string) => (html.match(/data-animated="true"/g) ?? []).length;

describe("DotMatrix", () => {
  it("renders a full 5x5 grid with a status label", () => {
    const html = renderToStaticMarkup(<DotMatrix state="working" label="Working" />);
    expect((html.match(/<circle/g) ?? []).length).toBe(25);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Working"');
    expect(html).toContain('data-state="working"');
  });

  it("animates every dot in working and none in done", () => {
    expect(countAnimated(renderToStaticMarkup(<DotMatrix state="working" />))).toBe(25);
    expect(countAnimated(renderToStaticMarkup(<DotMatrix state="done" />))).toBe(0);
  });

  it("animates only glyph dots in blinking glyph states", () => {
    // BANG glyph has 4 dots, CROSS has 9.
    expect(countAnimated(renderToStaticMarkup(<DotMatrix state="approval" />))).toBe(4);
    expect(countAnimated(renderToStaticMarkup(<DotMatrix state="error" />))).toBe(9);
  });

  it("gives static states no animation timeline at all", () => {
    for (const state of ["plan", "done", "idle"] as const) {
      const html = renderToStaticMarkup(<DotMatrix state={state} />);
      expect(html).not.toContain("animation-duration");
      expect(html).not.toContain('data-animated="true"');
    }
  });

  it("renders identical markup across renders (deterministic hash)", () => {
    const a = renderToStaticMarkup(<DotMatrix state="working" />);
    const b = renderToStaticMarkup(<DotMatrix state="working" />);
    expect(a).toBe(b);
  });

  it("falls back to the state name as the accessible label", () => {
    expect(renderToStaticMarkup(<DotMatrix state="connecting" />)).toContain(
      'aria-label="connecting"',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run apps/web/src/components/ui/dot-matrix.test.tsx`
Expected: FAIL — cannot resolve `./dot-matrix`.

- [ ] **Step 3: Write the component**

Create `apps/web/src/components/ui/dot-matrix.tsx`:

```tsx
import type { CSSProperties } from "react";
import { cn } from "~/lib/utils";

const GRID = 5;
const CENTER = (GRID - 1) / 2;
const DOT_INDEXES = Array.from({ length: GRID * GRID }, (_, i) => i);

/* Deterministic bit-mixing hash so repeated renders produce identical markup;
   takes a range in milliseconds and returns seconds. A plain (i * prime) % range
   correlates indexes a grid-stride apart and renders as column-synchronized
   waves instead of a twinkle. */
function hash(n: number, salt: number, range: number): number {
  let h = (Math.imul(n, 374761393) + Math.imul(salt, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) % range) / 1000;
}

const glyph = (dots: ReadonlyArray<readonly [number, number]>) =>
  new Set(dots.map(([row, col]) => row * GRID + col));

const CHECK = glyph([
  [1, 4],
  [2, 3],
  [3, 0],
  [3, 2],
  [4, 1],
]);
const CROSS = glyph([
  [0, 0],
  [0, 4],
  [1, 1],
  [1, 3],
  [2, 2],
  [3, 1],
  [3, 3],
  [4, 0],
  [4, 4],
]);
const BANG = glyph([
  [0, 2],
  [1, 2],
  [2, 2],
  [4, 2],
]);
const INFO = glyph([
  [0, 2],
  [2, 2],
  [3, 2],
  [4, 2],
]);
const ELLIPSIS = glyph([
  [2, 0],
  [2, 2],
  [2, 4],
]);
const RECORD = glyph([
  [1, 2],
  [2, 1],
  [2, 2],
  [2, 3],
  [3, 2],
]);
/* ">_" shell prompt: a full-height chevron plus a cursor underscore. */
const PROMPT = glyph([
  [0, 0],
  [1, 1],
  [2, 2],
  [3, 1],
  [4, 0],
  [4, 3],
  [4, 4],
]);

type Blink = { duration: number; delay: number; lo: number };

type StateConfig = {
  /** Dots that render at full opacity; all others rest at `dim`. Omit for the full grid. */
  glyph?: Set<number>;
  /** Resting opacity of on dots. */
  base?: number;
  /** Resting opacity of off dots when a glyph is set. */
  dim?: number;
  /** Blink parameters per on dot, keyed by index and grid position. */
  blink?: (i: number, row: number, col: number) => Blink;
};

const STATES = {
  /** Row sweep with per-column jitter — the agent is actively producing work. */
  working: {
    blink: (_i, row, col) => ({
      duration: 0.9,
      delay: -(row * 0.12 + hash(col, 3, 900)),
      lo: 0.15,
    }),
  },
  /** Center-out ripple — a connection is being established. */
  connecting: {
    blink: (_i, row, col) => ({
      duration: 1.4,
      delay: -Math.max(Math.abs(row - CENTER), Math.abs(col - CENTER)) * 0.18,
      lo: 0.15,
    }),
  },
  approval: { glyph: BANG, blink: () => ({ duration: 1.6, delay: 0, lo: 0.45 }) },
  input: {
    glyph: ELLIPSIS,
    blink: (_i, _row, col) => ({ duration: 1.2, delay: -col * 0.09, lo: 0.2 }),
  },
  plan: { glyph: INFO },
  done: { glyph: CHECK },
  error: { glyph: CROSS, blink: () => ({ duration: 1.1, delay: 0, lo: 0.4 }) },
  idle: { base: 0.3 },
  terminal: { glyph: PROMPT, blink: () => ({ duration: 1.6, delay: 0, lo: 0.5 }) },
  recording: { glyph: RECORD, dim: 0.12, blink: () => ({ duration: 1.4, delay: 0, lo: 0.3 }) },
  live: { glyph: RECORD, dim: 0.12, blink: () => ({ duration: 2, delay: 0, lo: 0.55 }) },
} satisfies Record<string, StateConfig>;

export type DotMatrixState = keyof typeof STATES;

export type DotMatrixProps = Omit<React.ComponentProps<"span">, "children"> & {
  state: DotMatrixState;
  label?: string;
};

/**
 * 5×5 dot-matrix status indicator — Pylon's shared status language. Dots
 * inherit the surrounding text color; callers pick hue with a text class and
 * size with a size class (14px+ keeps dots legible). Animated states blink
 * per-dot with stepped timing; static glyph states carry no animation
 * timeline, so a wall of settled threads costs the compositor nothing.
 */
function DotMatrix({ className, state, label, ...props }: DotMatrixProps) {
  const config: StateConfig = STATES[state];
  return (
    <span
      role="status"
      aria-label={label ?? state}
      data-state={state}
      className={cn("inline-flex shrink-0", className)}
      {...props}
    >
      <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="size-full">
        {DOT_INDEXES.map((i) => {
          const row = Math.floor(i / GRID);
          const col = i % GRID;
          const on = !config.glyph || config.glyph.has(i);
          const rest = on ? (config.base ?? 1) : (config.dim ?? 0.15);
          const blink = on ? config.blink?.(i, row, col) : undefined;
          return (
            <circle
              key={i}
              className="dot-matrix-dot"
              cx={2 + col * 4}
              cy={2 + row * 4}
              r={1.4}
              data-animated={blink ? "true" : undefined}
              style={
                {
                  fillOpacity: rest,
                  ...(blink
                    ? {
                        animationDuration: `${blink.duration}s`,
                        animationDelay: `${blink.delay}s`,
                        "--dot-matrix-blink-lo": rest > 0 ? blink.lo / rest : 1,
                      }
                    : {}),
                } as CSSProperties
              }
            />
          );
        })}
      </svg>
    </span>
  );
}

export { DotMatrix };
```

Append to `apps/web/src/index.css`, directly after the closing `}` of the `@theme inline` block (currently line 237):

```css
/* Dot-matrix status indicator. Per-dot duration/delay arrive inline from the
   DotMatrix component; steps() holds keep many concurrent indicators cheap for
   the compositor (same duty-cycle discipline as status-pulse above). The blink
   animates element opacity while resting brightness lives in fill-opacity, so
   state changes cross-fade independently of the blink. */
@keyframes dot-matrix-blink {
  0%,
  40% {
    opacity: 1;
    animation-timing-function: steps(4);
  }
  50%,
  90% {
    opacity: var(--dot-matrix-blink-lo, 1);
    animation-timing-function: steps(4);
  }
  100% {
    opacity: 1;
  }
}
.dot-matrix-dot {
  transition: fill-opacity 0.3s;
}
.dot-matrix-dot[data-animated="true"] {
  animation: dot-matrix-blink 1s infinite;
}
@media (prefers-reduced-motion: reduce) {
  .dot-matrix-dot[data-animated="true"] {
    animation: none;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `vp test run apps/web/src/components/ui/dot-matrix.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/dot-matrix.tsx apps/web/src/components/ui/dot-matrix.test.tsx apps/web/src/index.css
git commit -m "feat(web): add DotMatrix status indicator primitive"
```

---

### Task 2: `matrix` field on the thread status pill

**Files:**

- Modify: `apps/web/src/components/Sidebar.logic.ts:116-127` (interface) and `:574-639` (resolver)
- Test: `apps/web/src/components/Sidebar.logic.test.ts` (`resolveThreadStatusPill` describe block at :876)

**Interfaces:**

- Consumes: `DotMatrixState` type from Task 1.
- Produces: `ThreadStatusPill` gains `matrix: DotMatrixState`. `dotClass`/`pulse` remain **until Task 3** so existing consumers keep compiling. Mapping: Pending Approval → `"approval"`, Awaiting Input → `"input"`, Working → `"working"`, Connecting → `"connecting"`, Plan Ready → `"plan"`, Completed → `"done"`.

- [ ] **Step 1: Extend the failing tests**

In `Sidebar.logic.test.ts`, extend the existing `toMatchObject` assertions in the `resolveThreadStatusPill` describe block (they currently assert `{ label, pulse }`) to include the new field:

```ts
// :905  → .toMatchObject({ label: "Pending Approval", pulse: false, matrix: "approval" });
// :916  → .toMatchObject({ label: "Awaiting Input", pulse: false, matrix: "input" });
// :924  → .toMatchObject({ label: "Working", pulse: true, matrix: "working" });
// plan-ready case → .toMatchObject({ label: "Plan Ready", matrix: "plan" });
// completed case  → .toMatchObject({ label: "Completed", matrix: "done" });
// connecting case (session.status "starting") → .toMatchObject({ label: "Connecting", matrix: "connecting" });
```

If any of those cases (connecting, plan-ready, completed) lack an existing test, add one following the `baseThread` fixture pattern at `:877-894` — e.g. connecting:

```ts
it("shows connecting while the session is starting", () => {
  expect(
    resolveThreadStatusPill({
      thread: { ...baseThread, session: { ...baseThread.session, status: "starting" as const } },
    }),
  ).toMatchObject({ label: "Connecting", matrix: "connecting" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `vp test run apps/web/src/components/Sidebar.logic.test.ts`
Expected: FAIL — `matrix` is `undefined` on every pill.

- [ ] **Step 3: Implement**

In `Sidebar.logic.ts`:

```ts
import type { DotMatrixState } from "./ui/dot-matrix";

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
  matrix: DotMatrixState;
}
```

Add `matrix` to each branch of `resolveThreadStatusPill` (`:574-639`): `"approval"`, `"input"`, `"working"`, `"connecting"`, `"plan"`, `"done"` respectively. `resolveProjectStatusIndicator` needs no change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `vp test run apps/web/src/components/Sidebar.logic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts
git commit -m "feat(web): map thread statuses to dot-matrix states"
```

---

### Task 3: Sidebar v1 + command palette dots

**Files:**

- Modify: `apps/web/src/components/ThreadStatusIndicators.tsx:176-225` (`ThreadStatusLabel`)
- Modify: `apps/web/src/components/Sidebar.tsx:2231-2251` (project rollup dot)
- Modify: `apps/web/src/components/Sidebar.logic.ts` (delete `dotClass`/`pulse`)
- Test: `apps/web/src/components/Sidebar.logic.test.ts` (drop `pulse` from assertions)

**Interfaces:**

- Consumes: `DotMatrix` (Task 1), `ThreadStatusPill.matrix` (Task 2).
- Produces: `ThreadStatusPill` is now `{ label, colorClass, matrix }` — `dotClass` and `pulse` are gone. Any later task referencing the pill uses only these three fields.

- [ ] **Step 1: Swap `ThreadStatusLabel` dots for DotMatrix**

In `ThreadStatusIndicators.tsx`, add `import { DotMatrix } from "./ui/dot-matrix";` and replace both dot spans. Compact variant (`:183-203`) — the trigger span already carries `size-3.5` and `colorClass`; the matrix fills it:

```tsx
if (compact) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
          />
        }
      >
        <DotMatrix state={status.matrix} label={status.label} className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}
```

Full variant (`:205-224`) — replace the `h-1.5 w-1.5` dot span with:

```tsx
<DotMatrix state={status.matrix} label={status.label} className="size-3.5" />
```

(keep the sibling `<span className="hidden md:inline">{status.label}</span>` and the surrounding Tooltip exactly as-is).

- [ ] **Step 2: Swap the project rollup dot**

In `Sidebar.tsx:2241-2247`, replace the inner dot span (keep the wrapper that owns the hover cross-fade to the chevron):

```tsx
<span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
  <DotMatrix state={projectStatus.matrix} label={projectStatus.label} className="size-3.5" />
</span>
```

Add the `DotMatrix` import to `Sidebar.tsx`.

- [ ] **Step 3: Delete `dotClass` and `pulse`**

Remove both fields from the `ThreadStatusPill` interface and every branch of `resolveThreadStatusPill` in `Sidebar.logic.ts`. Remove `pulse:` from the `toMatchObject` assertions in `Sidebar.logic.test.ts`. Grep to confirm no survivors:

Run: `grep -rn "dotClass\b\|status\.pulse\|projectStatus\.pulse" apps/web/src --include="*.tsx" --include="*.ts" | grep -v dotClassName`
Expected: no matches.

- [ ] **Step 4: Verify**

Run: `vp test run apps/web/src/components/Sidebar.logic.test.ts && vp exec tsc -p apps/web --noEmit`
(If `vp exec tsc` is not a valid invocation in this repo, use the package's own typecheck script scoped to `apps/web`: `vp run typecheck --filter @t3tools/web` — check `apps/web/package.json` scripts for the exact name; do not run repo-wide checks.)
Expected: tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ThreadStatusIndicators.tsx apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts
git commit -m "feat(web): render sidebar thread status as dot-matrix"
```

---

### Task 4: Sidebar v2 status label

**Files:**

- Modify: `apps/web/src/components/SidebarV2.tsx:485-523` (topStatus config) and `:961-967` (icon rendering)
- Modify: `apps/web/src/index.css:140` and `:222-236` (remove `--animate-sidebar-working-text` token + keyframes)

**Interfaces:**

- Consumes: `DotMatrix` (Task 1).
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Update the topStatus config**

In `SidebarV2.tsx:485-523`, remove the breathe class from working and give failed an icon (hues unchanged — the sky-600/sky-400 working colors now tint the matrix):

```tsx
const topStatus =
  status === "working"
    ? {
        label: "Working",
        icon: "working" as const,
        className: "text-sky-600 dark:text-sky-400",
      }
    : status === "approval"
      ? {
          label: "Approval",
          icon: null,
          className: "text-amber-700 dark:text-amber-300",
        }
      : status === "input"
        ? {
            label: "Input",
            icon: null,
            className: "text-indigo-600 dark:text-indigo-300",
          }
        : status === "failed"
          ? {
              label: "Failed",
              icon: "failed" as const,
              className: "text-red-700 dark:text-red-300",
            }
          : isWoke
            ? {
                label: "Woke",
                icon: "woke" as const,
                className: "text-amber-700 dark:text-amber-300",
              }
            : isUnread
              ? {
                  label: "Done",
                  icon: "done" as const,
                  className: "text-emerald-700 dark:text-emerald-300",
                }
              : null;
```

- [ ] **Step 2: Update the icon rendering**

At `:961-967`, replace the icon chain (AlarmClock stays; the aria-hidden wrapper keeps the matrix out of the live region — the label span at `:971` already announces status):

```tsx
{
  topStatus.icon === "working" ? (
    <DotMatrix aria-hidden state="working" className="size-4" />
  ) : topStatus.icon === "failed" ? (
    <DotMatrix aria-hidden state="error" className="size-4" />
  ) : topStatus.icon === "done" ? (
    <DotMatrix aria-hidden state="done" className="size-4" />
  ) : topStatus.icon === "woke" ? (
    <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
  ) : null;
}
```

Add the `DotMatrix` import; remove the now-unused `CircleDashedIcon` and `CircleCheckIcon` imports (verify with grep that nothing else in the file uses them before deleting).

Note: `aria-hidden` on DotMatrix suppresses its `role="status"` announcement — correct here, since the adjacent text label is the live region.

- [ ] **Step 3: Remove the dead breathe animation**

`SidebarV2.tsx:491` was the only consumer (verify: `grep -rn "sidebar-working-text" apps/web/src` → only `index.css` remains). Delete from `index.css`: the `--animate-sidebar-working-text` token (line 140) and the `@keyframes sidebar-working-text` block (lines 222-236).

- [ ] **Step 4: Verify**

Run: `vp test run apps/web/src/components/SidebarV2.test.tsx` (if that test file exists — check with `ls`; otherwise rely on typecheck) and the targeted typecheck from Task 3 Step 4.
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/SidebarV2.tsx apps/web/src/index.css
git commit -m "feat(web): dot-matrix status in sidebar v2, drop text breathe"
```

---

### Task 5: Chat timeline working row

**Files:**

- Modify: `apps/web/src/components/chat/MessagesTimeline.tsx:1094-1115` (`WorkingTimelineRow`)

**Interfaces:**

- Consumes: `DotMatrix` (Task 1), imported as `import { DotMatrix } from "../ui/dot-matrix";`.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Replace the three pulsing dots**

```tsx
function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70 tabular-nums">
        <DotMatrix aria-hidden state="working" className="size-4 text-sky-600 dark:text-sky-400" />
        <span>
          {row.createdAt ? (
            <>
              Working for <WorkingTimer createdAt={row.createdAt} />
            </>
          ) : (
            "Working..."
          )}
        </span>
      </div>
    </div>
  );
}
```

(`aria-hidden`: the row's text already says "Working"; a `role="status"` here would double-announce next to the ticking timer.)

- [ ] **Step 2: Verify**

Run: `vp test run apps/web/src/components/chat/MessagesTimeline.logic.test.ts` (logic unchanged — this is a regression guard; skip if the file doesn't exist) plus the targeted typecheck.
Expected: PASS / clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/chat/MessagesTimeline.tsx
git commit -m "feat(web): dot-matrix working indicator in chat timeline"
```

---

### Task 6: Connecting/updating banners

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx:1926-1931` and `:1980-1985`

**Interfaces:**

- Consumes: `DotMatrix` (Task 1), imported as `import { DotMatrix } from "./ui/dot-matrix";`.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Replace both banner dots**

Both sites currently render `<span className="size-1.5 animate-status-pulse rounded-full bg-foreground" aria-hidden="true" />` as the banner `icon`. Replace each with:

```tsx
<DotMatrix aria-hidden state="connecting" className="size-3.5 text-foreground" />
```

- [ ] **Step 2: Verify**

Targeted typecheck (Task 3 Step 4 command).
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ChatView.tsx
git commit -m "feat(web): dot-matrix connecting indicator in chat banners"
```

---

### Task 7: Terminal-process indicator

**Files:**

- Modify: `apps/web/src/components/ThreadStatusIndicators.tsx:30-34` (type), `:129-140` (`terminalStatusFromRunningIds`), `:317-334` (trailing status render)
- Modify: `apps/web/src/components/Sidebar.tsx:757-770` (thread row terminal icon at :764)
- Modify: `apps/web/src/components/SidebarV2.tsx:775-782` (terminal icon at :779)

**Interfaces:**

- Consumes: `DotMatrix` (Task 1).
- Produces: `TerminalStatusIndicator` becomes `{ label: "Terminal process running"; colorClass: string }` — `pulse` is deleted. All three render sites replace `TerminalIcon` with `<DotMatrix state="terminal" … />`.

- [ ] **Step 1: Update the type and resolver**

```ts
export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
  };
}
```

- [ ] **Step 2: Swap all three render sites**

`ThreadStatusIndicators.tsx:328-330` — replace `<TerminalIcon className={…pulse…} />` with:

```tsx
<DotMatrix aria-hidden state="terminal" className="size-3" />
```

(the wrapper span at `:321-326` already carries `role="img"`, the aria-label, and `colorClass`).

`Sidebar.tsx:764` — same replacement, keeping that site's existing wrapper/tooltip and `size-3`.

`SidebarV2.tsx:779` — replace `<TerminalIcon className={cn("size-3.5", terminalStatus.pulse && "animate-status-pulse")} />` with:

```tsx
<DotMatrix aria-hidden state="terminal" className="size-3.5" />
```

Remove now-unused `TerminalIcon` imports from any of the three files where nothing else references it (grep each file first).

- [ ] **Step 3: Verify**

Run: `grep -rn "terminalStatus.pulse" apps/web/src` → no matches. Then targeted typecheck.
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ThreadStatusIndicators.tsx apps/web/src/components/Sidebar.tsx apps/web/src/components/SidebarV2.tsx
git commit -m "feat(web): dot-matrix terminal-running indicator"
```

---

### Task 8: Preview recording badge

**Files:**

- Modify: `apps/web/src/components/preview/PreviewChromeRow.tsx:275-277`

**Interfaces:**

- Consumes: `DotMatrix` (Task 1), imported as `import { DotMatrix } from "../ui/dot-matrix";`.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Replace the badge**

The current badge is a 6px pulsing dot pinned to the camera button's corner. A 5×5 matrix needs more room to read, so it grows to 12px and shifts to the outer corner:

```tsx
{
  recording ? (
    <DotMatrix
      aria-hidden
      state="recording"
      className="absolute -right-1 -top-1 size-3 text-destructive"
    />
  ) : null;
}
```

(Flag for the final visual pass: if 12px crowds the button, drop back to a plain dot — this is the one surface where the matrix may not fit.)

- [ ] **Step 2: Verify**

Targeted typecheck.
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/preview/PreviewChromeRow.tsx
git commit -m "feat(web): dot-matrix recording badge in preview chrome"
```

---

### Task 9: Connection status dots

**Files:**

- Modify: `apps/web/src/components/ConnectionStatusDot.tsx` (full rewrite of the internals, same file)
- Modify: `apps/web/src/components/settings/ConnectionsSettings.tsx:738-741`, `:935-939`, `:1359-1366` + `:1420-1428`
- Modify: `apps/web/src/components/cloud/CloudEnvironmentConnectList.tsx:179-215`
- Modify: `apps/web/src/components/preview/PreviewLocalServerCard.tsx:36-52`

**Interfaces:**

- Consumes: `DotMatrix`, `DotMatrixState` (Task 1).
- Produces: `ConnectionStatusDot` props become `{ tooltipText?: string | null; state: "live" | "connecting" | "error" | "idle"; colorClassName: string }`. `dotClassName`/`pingClassName` are deleted.

- [ ] **Step 1: Rewrite `ConnectionStatusDot`**

```tsx
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { DotMatrix, type DotMatrixState } from "~/components/ui/dot-matrix";

type ConnectionStatusDotProps = {
  tooltipText?: string | null;
  state: Extract<DotMatrixState, "live" | "connecting" | "error" | "idle">;
  colorClassName: string;
};

export function ConnectionStatusDot({
  tooltipText,
  state,
  colorClassName,
}: ConnectionStatusDotProps) {
  const dotContent = (
    <DotMatrix aria-hidden state={state} className={cn("size-3.5", colorClassName)} />
  );

  if (!tooltipText) {
    return (
      <span className="relative flex size-3.5 shrink-0 items-center justify-center">
        {dotContent}
      </span>
    );
  }

  const dot = (
    <button
      type="button"
      title={tooltipText}
      aria-label={tooltipText}
      className="relative flex size-3.5 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden"
    >
      {dotContent}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}
```

- [ ] **Step 2: Migrate `ConnectionsSettings.tsx` (3 sites)**

`:738-741` (pairing link, static amber today):

```tsx
<ConnectionStatusDot
  tooltipText={`Link created at ${formatAccessTimestamp(pairingLink.createdAt)}`}
  state="live"
  colorClassName="text-amber-400"
/>
```

`:935-939` (client session):

```tsx
<ConnectionStatusDot
  tooltipText={statusTooltip}
  state={isLive ? "live" : "idle"}
  colorClassName={isLive ? "text-success" : "text-muted-foreground/40"}
/>
```

`:1359-1366` — replace the `stateDotClassName` derivation with a state + color pair:

```tsx
const connectionDot =
  connectionState === "connected"
    ? { state: "live" as const, colorClassName: "text-success" }
    : connectionState === "connecting" || connectionState === "reconnecting"
      ? { state: "connecting" as const, colorClassName: "text-warning" }
      : connectionState === "error"
        ? { state: "error" as const, colorClassName: "text-destructive" }
        : { state: "idle" as const, colorClassName: "text-muted-foreground/40" };
```

and at `:1420-1428`:

```tsx
<ConnectionStatusDot
  tooltipText={statusTooltip}
  state={connectionDot.state}
  colorClassName={connectionDot.colorClassName}
/>
```

- [ ] **Step 3: Migrate `CloudEnvironmentConnectList.tsx`**

Replace the `dotClassName` derivation at `:179-193` with:

```tsx
const connectionDot = savedConnection
  ? savedConnection.tone === "connected"
    ? { state: "live" as const, colorClassName: "text-success" }
    : savedConnection.tone === "connecting"
      ? { state: "connecting" as const, colorClassName: "text-warning" }
      : savedConnection.tone === "error"
        ? { state: "error" as const, colorClassName: "text-destructive" }
        : { state: "idle" as const, colorClassName: "text-muted-foreground/35" }
  : availability === "online"
    ? { state: "live" as const, colorClassName: "text-success" }
    : availability === "error"
      ? { state: "error" as const, colorClassName: "text-destructive" }
      : availability === "checking"
        ? { state: "connecting" as const, colorClassName: "text-warning" }
        : { state: "idle" as const, colorClassName: "text-muted-foreground/35" };
```

and at `:208-215`:

```tsx
<ConnectionStatusDot
  state={connectionDot.state}
  colorClassName={connectionDot.colorClassName}
  tooltipText={/* unchanged tooltip expression */}
/>
```

- [ ] **Step 4: Migrate `PreviewLocalServerCard.tsx`**

```tsx
function PulsingDot() {
  return <DotMatrix state="live" label="Listening" className="size-3 shrink-0 text-success" />;
}

function DimDot() {
  return (
    <DotMatrix
      state="idle"
      label="Not currently listening"
      className="size-3 shrink-0 text-muted-foreground/40"
    />
  );
}
```

- [ ] **Step 5: Verify**

Run: `grep -rn "dotClassName\|pingClassName" apps/web/src` → no matches. Targeted typecheck. Also confirm `animate-status-ping` still has consumers (`AgentBrowserCursor.tsx`) so the keyframes stay: `grep -rn "animate-status-ping" apps/web/src` → only `AgentBrowserCursor.tsx`.
Expected: clean; ping remains for the cursor only.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ConnectionStatusDot.tsx apps/web/src/components/settings/ConnectionsSettings.tsx apps/web/src/components/cloud/CloudEnvironmentConnectList.tsx apps/web/src/components/preview/PreviewLocalServerCard.tsx
git commit -m "feat(web): dot-matrix connection status dots"
```

---

### Task 10: Final sweep and integrated visual pass

**Files:**

- Possibly modify: `apps/web/src/index.css`, any file flagged by lint

**Interfaces:** none.

- [ ] **Step 1: Confirm no orphaned animation machinery**

- `grep -rn "animate-status-pulse" apps/web/src` → expected remaining consumers: `ServerUpdateAction.tsx:65` only (its step list was explicitly kept out of scope). If others remain, they were missed — check against the spec's surface list before touching them.
- `grep -rn "sidebar-working-text" apps/web/src` → no matches.
- `grep -rn "CircleDashedIcon" apps/web/src/components/SidebarV2.tsx` → no matches.

- [ ] **Step 2: Targeted lint over touched files**

Run: `vp exec biome check apps/web/src/components/ui/dot-matrix.tsx apps/web/src/components/ThreadStatusIndicators.tsx apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.logic.ts apps/web/src/components/SidebarV2.tsx apps/web/src/components/chat/MessagesTimeline.tsx apps/web/src/components/ChatView.tsx apps/web/src/components/preview/PreviewChromeRow.tsx apps/web/src/components/ConnectionStatusDot.tsx apps/web/src/components/settings/ConnectionsSettings.tsx apps/web/src/components/cloud/CloudEnvironmentConnectList.tsx apps/web/src/components/preview/PreviewLocalServerCard.tsx`
(If `biome` is not the repo linter, check `apps/web/package.json` for the lint script and scope it to these files. Never lint the whole repo.)
Expected: clean.

- [ ] **Step 3: Re-run the full touched-test set**

Run: `vp test run apps/web/src/components/ui/dot-matrix.test.tsx apps/web/src/components/Sidebar.logic.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit any stragglers**

```bash
git add -A && git commit -m "chore(web): tidy after dot-matrix migration"
```

(Skip if the tree is clean.)

- [ ] **Step 5: Integrated visual pass (requires developer go-ahead)**

**STOP — ask the developer for permission before this step** (repo rule: no browsers/computer use without explicit agreement). With permission, use the `test-pylon-app` skill to launch the worktree's dev server and verify, in both light and dark mode:

1. Sidebar v1: a working thread shows the sky row-sweep matrix; approval/input/plan/done threads show their glyphs; collapsed project rolls up correctly and hover still cross-fades to the chevron.
2. Sidebar v2: "Working" shows the matrix + static text + ticking timer; Done/Failed glyphs render.
3. Chat: send a message — timeline shows the sky matrix next to "Working for Ns"; a connecting banner (restart the env or reconnect) shows the ripple.
4. Terminal indicator: run a long command in a thread terminal — teal `>_` glyph appears in the row.
5. Settings → Connections: live sessions breathe green; a connecting environment ripples amber.
6. Tune dot radius if dots look muddy or blown out at 14px (spec allows one tuning pass on `r`), and check the recording badge fit (Task 8 flag).
7. Confirm CPU stays calm with many working threads visible (Activity Monitor spot check).

Screenshot before/after for the eventual PR (UI changes need images per repo rules).

---

## Self-review notes

- **Spec coverage:** primitive + CSS (Task 1 ↔ spec §1), 11 states (Task 1 ↔ §2), resolver mapping (Task 2 ↔ §3), surfaces 1-2 (Task 3), surface 3 (Task 4), surface 4 (Task 5), surface 5 (Task 6), surface 6 (Task 7), surface 7 (Task 8), surface 8 (Task 9), motion/perf constraints (Task 1 CSS + global constraints ↔ §5), testing (Tasks 1-3 + Task 10 ↔ §6). Keyframe cleanup rule (§4 "removed only when their last consumer migrates") → Task 4 Step 3 and Task 10 Step 1.
- **Type consistency:** `DotMatrixState` union defined once in Task 1 and imported everywhere; `ThreadStatusPill.matrix` introduced Task 2, `dotClass`/`pulse` deleted Task 3; `TerminalStatusIndicator.pulse` deleted Task 7; `ConnectionStatusDot` new props defined in Task 9 and used consistently across all four consumer files.
- **Known judgment calls recorded in-task:** recording badge size (Task 8 flag), pairing-link dot mapped to `live` amber (Task 9 Step 2), `aria-hidden` on matrices that sit next to text labels.
