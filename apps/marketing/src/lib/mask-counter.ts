// Shared across a build so inline SVG masks get page-unique ids. Astro has no
// useId equivalent, and duplicate mask ids collapse to the first definition.
export const maskCounter = { value: 0 };
