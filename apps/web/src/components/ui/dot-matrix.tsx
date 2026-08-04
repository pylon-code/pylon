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
  return (((h ^ (h >>> 16)) >>> 0) % range) / 1000;
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
/* The 12-dot perimeter of the 5x5 grid, corners excluded, so it reads as a
   circle rather than a square. */
const RING = glyph([
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 0],
  [1, 4],
  [2, 0],
  [2, 4],
  [3, 0],
  [3, 4],
  [4, 1],
  [4, 2],
  [4, 3],
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
  /** Use the narrow-duty-cycle chase keyframe instead of the 50/50 blink, so a
   * single dot travels around the glyph rather than half of it lighting at once. */
  chase?: boolean;
};

const STATES = {
  /** Row sweep with per-column jitter — the agent is actively producing work. */
  working: {
    blink: (_i: number, row: number, col: number) => ({
      duration: 0.9,
      delay: -(row * 0.12 + hash(col, 3, 900)),
      lo: 0.15,
    }),
  },
  /** Center-out ripple — a connection is being established. */
  connecting: {
    blink: (_i: number, row: number, col: number) => ({
      duration: 1.4,
      delay: -Math.max(Math.abs(row - CENTER), Math.abs(col - CENTER)) * 0.18,
      lo: 0.15,
    }),
  },
  /** A single dot chasing around a ring — the agent is actively producing work. */
  spinner: {
    glyph: RING,
    dim: 0.06,
    chase: true,
    blink: (_i: number, row: number, col: number) => {
      const turn = (Math.atan2(row - CENTER, col - CENTER) + Math.PI) / (2 * Math.PI);
      return { duration: 1.1, delay: -(1 - turn) * 1.1, lo: 0.12 };
    },
  },
  approval: { glyph: BANG, blink: () => ({ duration: 1.6, delay: 0, lo: 0.45 }) },
  input: {
    glyph: ELLIPSIS,
    blink: (_i: number, _row: number, col: number) => ({
      duration: 1.2,
      delay: -col * 0.09,
      lo: 0.2,
    }),
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

/** Each state's canonical hue — the five-color status language shared across
 * every DotMatrix call site. `working`/`connecting`/`spinner` are "in
 * motion", `done`/`live` are "settled well", `error`/`recording` are
 * "needs attention now", `approval`/`input` are "needs a decision", and
 * `idle`/`terminal`/`plan` are unlabeled resting states. */
const TONE: Record<DotMatrixState, string> = {
  working: "text-primary",
  connecting: "text-primary",
  spinner: "text-primary",
  done: "text-success",
  live: "text-success",
  error: "text-destructive",
  recording: "text-destructive",
  approval: "text-warning",
  input: "text-warning",
  idle: "text-muted-foreground",
  terminal: "text-muted-foreground",
  plan: "text-muted-foreground",
};

/**
 * 5×5 dot-matrix status indicator — Pylon's shared status language. Each
 * state carries a canonical tone from `TONE` (dots render in `currentColor`,
 * so the tone class sets it); callers may override with a `className` text
 * color when a surface genuinely needs to differ. Size stays a caller
 * concern — pick a size class (14px+ keeps dots legible). Animated states
 * blink per-dot with stepped timing; static glyph states carry no animation
 * timeline, so a wall of settled threads costs the compositor nothing.
 */
function DotMatrix({ className, state, label, ...props }: DotMatrixProps) {
  const config: StateConfig = STATES[state];
  return (
    <span
      role="status"
      aria-label={label ?? state}
      data-state={state}
      className={cn("inline-flex shrink-0", TONE[state], className)}
      {...props}
    >
      <svg
        aria-hidden
        viewBox="0 0 20 20"
        fill="currentColor"
        className="size-full"
        style={{ color: "inherit" }}
      >
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
              data-animated={blink ? (config.chase ? "chase" : "true") : undefined}
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
