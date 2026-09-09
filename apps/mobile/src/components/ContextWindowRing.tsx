import { Circle, Svg } from "react-native-svg";
import { withUniwind } from "uniwind";

// Track and arc need different colours, so each circle is themed on its own and
// picks the value up through `currentColor`. These are `accent-*` classes, not
// `text-*`: only the accent family resolves to the `color` prop that
// `currentColor` reads, and a `text-*` class here silently renders black.
const ThemedCircle = withUniwind(Circle);

/**
 * Footprint of the drawn ring. Matches the web meter's `size-7` so the two
 * clients read as the same control.
 */
export const CONTEXT_WINDOW_RING_SIZE = 28;

// Geometry copied from the web meter (`ContextWindowMeter`) so a given
// percentage draws an identical arc on both clients.
const VIEW_BOX = 24;
const RADIUS = 9.75;
const STROKE_WIDTH = 3;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Context window usage as a dial, the same shape the web composer uses. The
 * reading is the arc; exact token counts belong to whatever control wraps this,
 * because a phone has no hover to reveal them on.
 */
export function ContextWindowRing(props: {
  /** null when the model's window size is unknown, so only the track draws. */
  readonly percent: number | null;
  readonly warning: boolean;
}) {
  const clamped = props.percent === null ? null : Math.max(0, Math.min(100, props.percent));

  return (
    <Svg
      width={CONTEXT_WINDOW_RING_SIZE}
      height={CONTEXT_WINDOW_RING_SIZE}
      viewBox={`0 0 ${VIEW_BOX} ${VIEW_BOX}`}
      // -90° puts zero at the top, so the arc fills clockwise from noon.
      style={{ transform: [{ rotate: "-90deg" }] }}
    >
      <ThemedCircle
        cx={VIEW_BOX / 2}
        cy={VIEW_BOX / 2}
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        colorClassName="accent-subtle-strong"
        strokeWidth={STROKE_WIDTH}
      />
      {clamped === null ? null : (
        <ThemedCircle
          cx={VIEW_BOX / 2}
          cy={VIEW_BOX / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          colorClassName={props.warning ? "accent-danger-foreground" : "accent-icon-muted"}
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - clamped / 100)}
        />
      )}
    </Svg>
  );
}
