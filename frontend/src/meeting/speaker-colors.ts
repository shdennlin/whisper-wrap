/**
 * Deterministic speaker → colour mapping.
 *
 * Given the `speakers` array order from a MeetingResult, this assigns each
 * speaker the next colour from a fixed palette. The mapping is stable across
 * reloads as long as the speakers array order is stable (which it is — the
 * server emits speakers in first-appearance order).
 *
 * Colours are chosen for visual distinction on both light and dark themes
 * (saturation moderated so the same palette works against any background).
 */

const PALETTE: ReadonlyArray<string> = [
  "#4C9AFF", // blue
  "#FF8B6B", // coral
  "#36B37E", // green
  "#FFC400", // amber
  "#B37FEB", // violet
  "#FF7AB6", // pink
  "#79E2F2", // cyan
  "#F38B00", // orange
  "#8DC44E", // lime
  "#F76E54", // tomato
];

export function speakerColorMap(
  speakers: ReadonlyArray<string>,
): Map<string, string> {
  const map = new Map<string, string>();
  speakers.forEach((s, idx) => {
    map.set(s, PALETTE[idx % PALETTE.length]);
  });
  return map;
}

export function paletteSize(): number {
  return PALETTE.length;
}
