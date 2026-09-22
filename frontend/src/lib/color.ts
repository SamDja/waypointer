// Colour-format helpers. Pure, no React.

/**
 * A Tailwind v4 palette colour (`oklch(L% C H)`, e.g. `colors.violet[600]`)
 * as an sRGB hex string, for the few consumers that can't take oklch() -
 * MapLibre's style validator rejects it in paint properties. Keeps Tailwind
 * the single source of truth for every colour, instead of hand-copied hex.
 *
 * Standard OKLCH -> OKLab -> linear sRGB -> sRGB conversion (Björn Ottosson's
 * matrices); a colour outside the sRGB gamut is clipped per channel, as
 * browsers do when painting it. An achromatic step's hue is `none`. Any
 * other input is returned unchanged.
 */
export function tailwindHex(value: string): string {
  const match = value.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+|none)\s*\)$/)
  if (!match) return value
  const lightness = Number(match[1]) / 100
  const chroma = Number(match[2])
  const hue = match[3] === "none" ? 0 : (Number(match[3]) * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const toByte = (channel: number) => {
    const c = Math.min(Math.max(channel, 0), 1)
    const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
    return Math.round(encoded * 255)
      .toString(16)
      .padStart(2, "0")
  }
  return `#${linear.map(toByte).join("")}`
}
