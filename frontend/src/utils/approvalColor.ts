// Friendly red→amber→green scale for approval %. The numeric % shown in each
// cell is the primary signal; color is a secondary cue, so red-green color
// blindness doesn't lose meaning. Hue sweeps 0° (red) → 130° (green) through
// amber near the middle; the light background keeps dark % text readable.
export function approvalColor(percent: number | null): {
  backgroundColor: string
  borderColor: string
} {
  if (percent == null) {
    return { backgroundColor: 'hsl(0, 0%, 95%)', borderColor: 'hsl(0, 0%, 85%)' }
  }
  const hue = (percent / 100) * 130
  return {
    backgroundColor: `hsl(${hue}, 70%, 90%)`,
    borderColor:     `hsl(${hue}, 55%, 70%)`,
  }
}
