export const JCODE_MARK_VIEW_BOX = "0 0 24 24";

export type JcodeMarkDot = readonly [
  centerX: number,
  centerY: number,
  radius: number,
  opacity: number,
];

/**
 * One tapered lobe from Jcode's animated website mark. Three rotations form a
 * static coarse-halftone swirl that stays legible at provider-icon sizes.
 */
const JCODE_MARK_BASE_LOBE = [
  [12.2, 2.8, 0.56, 0.62],
  [14.1, 3.1, 0.66, 0.68],
  [15.9, 3.8, 0.78, 0.75],
  [17.6, 4.9, 0.92, 0.84],
  [18.9, 6.4, 1.08, 0.94],
  [19.7, 8.3, 1.18, 1],
  [20, 10.3, 1.24, 1],
  [19.8, 12.4, 1.16, 0.98],
  [19.1, 14.3, 1.02, 0.92],
  [18, 15.9, 0.84, 0.8],
  [12.8, 5.1, 0.56, 0.64],
  [14.3, 5.5, 0.68, 0.72],
  [15.7, 6.3, 0.8, 0.8],
  [16.8, 7.5, 0.92, 0.88],
  [17.4, 9, 1.04, 0.96],
  [17.6, 10.7, 1.08, 1],
  [17.3, 12.3, 0.94, 0.93],
  [16.6, 13.7, 0.74, 0.8],
] as const satisfies ReadonlyArray<JcodeMarkDot>;

const roundMarkCoordinate = (value: number) => Math.round(value * 1_000) / 1_000;

function rotateMarkDot(dot: JcodeMarkDot, degrees: number): JcodeMarkDot {
  const [centerX, centerY, radius, opacity] = dot;
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const offsetX = centerX - 12;
  const offsetY = centerY - 12;

  return [
    roundMarkCoordinate(12 + offsetX * cosine - offsetY * sine),
    roundMarkCoordinate(12 + offsetX * sine + offsetY * cosine),
    radius,
    opacity,
  ];
}

export const JCODE_MARK_DOTS: ReadonlyArray<JcodeMarkDot> = [0, 120, 240].flatMap((degrees) =>
  JCODE_MARK_BASE_LOBE.map((dot) => rotateMarkDot(dot, degrees)),
);
