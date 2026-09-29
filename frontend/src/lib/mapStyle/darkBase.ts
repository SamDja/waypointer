import { Color } from "@maplibre/maplibre-gl-style-spec"

import { oklchToCss, srgbToOklch } from "../color"
import type { StylePatch } from "./compose"

/**
 * The dark theme's starting point: liberty's own colours, turned dark.
 *
 * Every colour Sulla Via sets itself - the house palette, each activity's
 * dims and highlights, contours - has a hand-picked dark Tailwind step next
 * to its light one, in the module that sets it. liberty.json paints dozens
 * more that nothing here touches (parks, landuse, boundaries, place and
 * water labels, their halos), and those are derived instead: this is the
 * one place map colours are computed rather than chosen, and it only ever
 * sees the vendored base. It runs first, before the house and activity
 * patches, so their explicit dark values land on top and nothing is
 * transformed twice.
 *
 *   liberty  ->  dark base (dark only)  ->  house style  ->  activity style
 */

// OKLCH lightness is flipped into a band rather than mirrored end to end: a
// white fill landing on pure black would be harsher than the dark UI around
// the map (stone-900 sits at ~0.22), and black text landing on pure white
// would glare. So white goes to DARKEST, black to LIGHTEST.
const DARKEST = 0.18
const LIGHTEST = 0.82
// Pale tints turned dark keep their hue but not all of their chroma - a
// fully saturated dark green park reads as neon beside the muted UI.
const CHROMA_SCALE = 0.7

const COLOR_SYNTAX = /^(#|rgba?\(|hsla?\()/

export function darkenColor(value: string): string {
  const color = COLOR_SYNTAX.test(value) ? Color.parse(value) : undefined
  if (!color) return value
  const [r, g, b, alpha] = color.rgb
  const { lightness, chroma, hue } = srgbToOklch(r, g, b)
  return oklchToCss(DARKEST + (1 - lightness) * (LIGHTEST - DARKEST), chroma * CHROMA_SCALE, hue, alpha)
}

// Expressions are walked whole, but only a string in colour syntax is ever
// rewritten - match labels and `get` keys pass through untouched.
function darkenValue(value: unknown): unknown {
  if (typeof value === "string") return darkenColor(value)
  if (Array.isArray(value)) return value.map(darkenValue)
  return value
}

export const darkenBase: StylePatch = (style) => ({
  ...style,
  layers: style.layers.map((layer) => {
    const paint = layer.paint as Record<string, unknown> | undefined
    if (!paint) return layer
    const darkened = Object.fromEntries(
      Object.entries(paint).map(([key, value]) => [key, key.endsWith("-color") ? darkenValue(value) : value]),
    )
    return { ...layer, paint: darkened } as typeof layer
  }),
})
