import { Color, type StyleSpecification } from "@maplibre/maplibre-gl-style-spec"
import { describe, expect, it } from "vitest"

import { srgbToOklch } from "../color"
import { MAP_STYLES, mapStyleFor } from "../mapStyles"
import { BASE_STYLE } from "./compose"
import { darkenColor } from "./darkBase"
import { TERRAIN_FILLS } from "./hiking"

const lightness = (value: string) => {
  const color = Color.parse(value)
  if (!color) throw new Error(`not a colour: ${value}`)
  const [r, g, b] = color.rgb
  return srgbToOklch(r, g, b).lightness
}

const paintOf = (style: StyleSpecification, layerId: string) =>
  (style.layers.find((l) => l.id === layerId)?.paint ?? {}) as Record<string, unknown>

// Every string in a colour property's value, expressions included.
function colourStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => colourStrings(v, out))
  return out
}

describe("darkenColor", () => {
  it("turns light colours dark and dark colours light", () => {
    expect(lightness(darkenColor("#ffffff"))).toBeLessThan(0.25)
    expect(lightness(darkenColor("hsl(0, 0%, 83%)"))).toBeLessThan(0.35)
    expect(lightness(darkenColor("#000000"))).toBeGreaterThan(0.7)
  })

  it("keeps a colour's alpha", () => {
    expect(Color.parse(darkenColor("rgba(147, 197, 253, 0.68)"))!.a).toBeCloseTo(0.68, 2)
  })

  it("leaves anything that isn't written as a colour alone", () => {
    // Match labels and `get` keys share the expression with the colours.
    for (const value of ["interpolate", "zoom", "class", "park", "tan"]) {
      expect(darkenColor(value)).toBe(value)
    }
  })
})

describe("dark map styles", () => {
  for (const { key } of MAP_STYLES) {
    const dark = mapStyleFor(key, "dark")

    it(`${key}: sits on an opaque dark ground`, () => {
      // A translucent background lets the page behind the canvas through.
      const background = paintOf(dark, "background")["background-color"] as string
      expect(Color.parse(background)!.a).toBe(1)
      expect(lightness(background)).toBeLessThan(0.3)
    })

    it(`${key}: leaves none of liberty's light fills in place`, () => {
      const kept: string[] = []
      for (const layer of BASE_STYLE.layers) {
        const fill = (layer.paint as Record<string, unknown> | undefined)?.["fill-color"]
        if (typeof fill !== "string") continue
        if (paintOf(dark, layer.id)["fill-color"] === fill && lightness(fill) > 0.6) kept.push(layer.id)
      }
      expect(kept).toEqual([])
    })

    it(`${key}: writes every colour in a form MapLibre parses`, () => {
      for (const layer of dark.layers) {
        for (const [prop, value] of Object.entries((layer.paint ?? {}) as Record<string, unknown>)) {
          if (!prop.endsWith("-color")) continue
          const colours = colourStrings(value).filter((v) => /^(#|rgb|hsl)/.test(v))
          for (const colour of colours) expect(Color.parse(colour), `${layer.id} ${prop}`).toBeDefined()
        }
      }
    })

    it(`${key}: draws labels lighter than their halos`, () => {
      for (const layer of dark.layers) {
        const paint = (layer.paint ?? {}) as Record<string, unknown>
        const text = paint["text-color"]
        const halo = paint["text-halo-color"]
        if (typeof text !== "string" || typeof halo !== "string") continue
        expect(lightness(text), layer.id).toBeGreaterThan(lightness(halo))
      }
    })
  }

  it("gives every terrain kind a look of its own in the dark too", () => {
    const hiking = mapStyleFor("hiking", "dark")
    const shades = TERRAIN_FILLS.map(({ id }) => {
      const paint = paintOf(hiking, id)
      return `${paint["fill-color"]} ${paint["fill-opacity"]}`
    })
    expect(new Set(shades).size, shades.join(", ")).toBe(TERRAIN_FILLS.length)
  })

  it("keeps each theme's style a single memoised object", () => {
    expect(mapStyleFor("hiking", "dark")).toBe(mapStyleFor("hiking", "dark"))
    expect(mapStyleFor("hiking", "dark")).not.toBe(mapStyleFor("hiking", "light"))
  })
})
