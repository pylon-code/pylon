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
const PAUSE = glyph([
  [1, 1],
  [2, 1],
  [3, 1],
  [1, 3],
  [2, 3],
  [3, 3],
]);
const STOP = glyph([
  [1, 1],
  [1, 2],
  [1, 3],
  [2, 1],
  [2, 2],
  [2, 3],
  [3, 1],
  [3, 2],
  [3, 3],
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
/* Pylon extension: a full-height chevron plus a cursor underscore. */
const PROMPT = glyph([
  [0, 0],
  [1, 1],
  [2, 2],
  [3, 1],
  [4, 0],
  [4, 2],
  [4, 3],
  [4, 4],
]);
/* Pylon extension: a circular fleet/orchestration indicator. */
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
  /** Use Pylon's fading-tail orbit instead of the shared blink keyframe. */
  chase?: boolean;
};

/**
 * Pylon's status language follows assistant-ui's standalone Dot Matrix states.
 * Neutral activity inherits the adaptive foreground tone; color is reserved for
 * semantic outcomes. Static states do not receive an animation timeline.
 */
const STATES = {
  idle: { base: 0.3 },
  loading: {
    blink: (i: number) => ({
      duration: 0.9 + hash(i, 2, 700),
      delay: -hash(i, 1, 1200),
      lo: 0.15,
    }),
  },
  orchestrating: {
    glyph: RING,
    dim: 0.06,
    chase: true,
    blink: (_i: number, row: number, col: number) => {
      const turn = (Math.atan2(row - CENTER, col - CENTER) + Math.PI) / (2 * Math.PI);
      return { duration: 1.1, delay: -(1 - turn) * 1.1, lo: 0.12 };
    },
  },
  queued: { glyph: ELLIPSIS },
  thinking: {
    blink: (_i: number, row: number, col: number) => ({
      duration: 1.2,
      delay: -(row + col) * 0.09,
      lo: 0.2,
    }),
  },
  streaming: {
    blink: (_i: number, row: number, col: number) => ({
      duration: 0.9,
      delay: -(row * 0.12 + hash(col, 3, 900)),
      lo: 0.15,
    }),
  },
  searching: {
    blink: (_i: number, _row: number, col: number) => ({
      duration: 1.1,
      delay: -col * 0.12,
      lo: 0.2,
    }),
  },
  syncing: {
    blink: (_i: number, row: number, col: number) => {
      const turn = (Math.atan2(row - CENTER, col - CENTER) + Math.PI) / (2 * Math.PI);
      return { duration: 1.3, delay: -turn * 1.3, lo: 0.2 };
    },
  },
  connecting: {
    blink: (_i: number, row: number, col: number) => ({
      duration: 1.4,
      delay: -Math.max(Math.abs(row - CENTER), Math.abs(col - CENTER)) * 0.18,
      lo: 0.15,
    }),
  },
  waiting: {
    glyph: ELLIPSIS,
    blink: (_i: number, _row: number, col: number) => ({
      duration: 1.2,
      delay: -col * 0.09,
      lo: 0.2,
    }),
  },
  uploading: {
    blink: (_i: number, row: number) => ({
      duration: 1,
      delay: -(GRID - 1 - row) * 0.12,
      lo: 0.2,
    }),
  },
  downloading: {
    blink: (_i: number, row: number) => ({
      duration: 1,
      delay: -row * 0.12,
      lo: 0.2,
    }),
  },
  listening: {
    blink: (_i: number, _row: number, col: number) => ({
      duration: 0.7 + hash(col, 4, 500),
      delay: -hash(col, 5, 900),
      lo: 0.25,
    }),
  },
  speaking: {
    blink: (_i: number, _row: number, col: number) => ({
      duration: 0.4 + hash(col, 6, 350),
      delay: -hash(col, 7, 700),
      lo: 0.2,
    }),
  },
  recording: {
    glyph: RECORD,
    dim: 0.12,
    blink: () => ({ duration: 1.4, delay: 0, lo: 0.3 }),
  },
  success: { glyph: CHECK },
  error: { glyph: CROSS, blink: () => ({ duration: 1.1, delay: 0, lo: 0.4 }) },
  warning: { glyph: BANG, blink: () => ({ duration: 1.6, delay: 0, lo: 0.45 }) },
  info: { glyph: INFO },
  paused: { glyph: PAUSE },
  stopped: { glyph: STOP },
  offline: { base: 0.15 },
  terminal: { glyph: PROMPT },
  "terminal-active": {
    glyph: PROMPT,
    blink: () => ({ duration: 1.7, delay: 0, lo: 0.35 }),
  },
} satisfies Record<string, StateConfig>;

export type DotMatrixState = keyof typeof STATES;

export const dotMatrixStates = Object.keys(STATES) as ReadonlyArray<DotMatrixState>;
export const dotMatrixAnimatedStates = dotMatrixStates.filter((state) => "blink" in STATES[state]);

export type DotMatrixProps = Omit<React.ComponentProps<"span">, "children"> & {
  state: DotMatrixState;
  label?: string;
};

const TONE: Record<DotMatrixState, string> = {
  idle: "text-muted-foreground",
  loading: "text-foreground",
  orchestrating: "text-foreground",
  queued: "text-muted-foreground",
  thinking: "text-foreground",
  streaming: "text-foreground",
  searching: "text-foreground",
  syncing: "text-foreground",
  connecting: "text-foreground",
  waiting: "text-foreground",
  uploading: "text-foreground",
  downloading: "text-foreground",
  listening: "text-foreground",
  speaking: "text-foreground",
  recording: "text-destructive",
  success: "text-success",
  error: "text-destructive",
  warning: "text-warning",
  info: "text-primary",
  paused: "text-muted-foreground",
  stopped: "text-muted-foreground",
  offline: "text-muted-foreground",
  terminal: "text-muted-foreground",
  "terminal-active": "text-foreground",
};

/**
 * A 5×5 status indicator adapted from assistant-ui's standalone Dot Matrix.
 * Each state combines a stable pattern, motion, and semantic tone. Active
 * neutral states use `text-foreground`, which reads white on dark themes and
 * dark on light themes. Callers own size and may override tone with className.
 */
function DotMatrix({ className, state, label, ...props }: DotMatrixProps) {
  const config: StateConfig = STATES[state];
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-slot="dot-matrix"
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
          const hi = on ? (config.base ?? 1) : (config.dim ?? 0.15);
          const blink = on ? config.blink?.(i, row, col) : undefined;
          return (
            <circle
              key={i}
              className="dot-matrix-dot"
              cx={2 + col * 4}
              cy={2 + row * 4}
              r={1.3}
              data-animated={blink ? (config.chase ? "chase" : "true") : undefined}
              style={
                {
                  opacity: hi,
                  "--dot-matrix-hi": hi,
                  "--dot-matrix-lo": blink?.lo ?? hi,
                  ...(blink
                    ? {
                        animationDuration: `${blink.duration}s`,
                        animationDelay: `${blink.delay}s`,
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
