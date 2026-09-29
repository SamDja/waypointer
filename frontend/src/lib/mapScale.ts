// The map's scale bar, as pure maths - no React, no MapLibre.

export interface ScaleBar {
  widthPx: number
  label: string
}

/**
 * The longest round distance (1, 2 or 5 × a power of ten) that fits in
 * `maxWidthPx`, given how many metres that width covers on the ground, and
 * how wide to draw it. Round numbers are what a reader can actually use to
 * judge distances, so the bar changes length rather than showing 437 m.
 */
export function scaleBar(metresAcrossMaxWidth: number, maxWidthPx: number): ScaleBar | null {
  if (!(metresAcrossMaxWidth > 0) || !(maxWidthPx > 0)) return null
  const magnitude = 10 ** Math.floor(Math.log10(metresAcrossMaxWidth))
  const leading = metresAcrossMaxWidth / magnitude
  const nice = (leading >= 5 ? 5 : leading >= 2 ? 2 : 1) * magnitude
  return {
    widthPx: (maxWidthPx * nice) / metresAcrossMaxWidth,
    label: nice >= 1000 ? `${nice / 1000} km` : `${nice} m`,
  }
}
