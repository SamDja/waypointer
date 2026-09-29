// Colour-format helpers. Pure, no React.

/**
 * A Tailwind v4 palette colour (`oklch(L% C H)`, e.g. `colors.violet[600]`)
 * as an sRGB hex string, for the few consumers that can't take oklch() -
 * MapLibre's style validator rejects it in paint properties. Keeps Tailwind
 * the single source of truth for every colour, instead of hand-copied hex.
 *
 * An achromatic step's hue is `none`. Any other input is returned unchanged.
 */
export function tailwindHex(value: string): string {
  const match = value.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+|none)\s*\)$/)
  if (!match) return value
  return oklchToCss(Number(match[1]) / 100, Number(match[2]), match[3] === "none" ? 0 : Number(match[3]))
}

/**
 * An OKLCH colour (lightness 0-1, chroma, hue in degrees) as CSS sRGB: hex
 * when opaque, `rgba()` otherwise. Standard OKLCH -> OKLab -> linear sRGB ->
 * sRGB conversion (Björn Ottosson's matrices); a colour outside the sRGB
 * gamut is clipped per channel, as browsers do when painting it.
 */
export function oklchToCss(lightness: number, chroma: number, hueDeg: number, alpha = 1): string {
  const hue = (hueDeg * Math.PI) / 180
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
  const bytes = linear.map((channel) => {
    const c = Math.min(Math.max(channel, 0), 1)
    const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
    return Math.round(encoded * 255)
  })
  if (alpha < 1) return `rgba(${bytes.join(", ")}, ${Math.round(alpha * 1000) / 1000})`
  return `#${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

export interface Oklch {
  lightness: number
  chroma: number
  hue: number
}

/** The inverse of `oklchToCss`, from sRGB channels in 0-1. */
export function srgbToOklch(r: number, g: number, b: number): Oklch {
  const linear = [r, g, b].map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  const l = Math.cbrt(0.4122214708 * linear[0] + 0.5363325363 * linear[1] + 0.0514459929 * linear[2])
  const m = Math.cbrt(0.2119034982 * linear[0] + 0.6806995451 * linear[1] + 0.1073969566 * linear[2])
  const s = Math.cbrt(0.0883024619 * linear[0] + 0.2817188376 * linear[1] + 0.6299787005 * linear[2])
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const hue = (Math.atan2(bb, a) * 180) / Math.PI
  return { lightness, chroma: Math.hypot(a, bb), hue: hue < 0 ? hue + 360 : hue }
}
