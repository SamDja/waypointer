import { Color, type StyleSpecification } from "@maplibre/maplibre-gl-style-spec"
import { describe, expect, it } from "vitest"

import { srgbToOklch } from "../color"
import { evaluateLineLayerPaint } from "../mapStyleLegend"
import { MAP_STYLES, mapStyleFor } from "../mapStyles"
import { BASE_STYLE } from "./compose"
import { darkenColor } from "./darkBase"
import { TERRAIN_FILLS } from "./hiking"

/**
 * What both themes of every activity have to get right, checked on the
 * finished styles: which things stand out, which recede, and that nothing
 * the dark theme can't restyle is left behind in light colours.
 */

const THEMES = ["light", "dark"] as const
const ZOOM = 16

const parse = (value: string) => {
  const color = Color.parse(value)
  if (!color) throw new Error(`not a colour: ${value}`)
  return color
}

const lightness = (value: string) => {
  const [r, g, b] = parse(value).rgb
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
    expect(parse(darkenColor("rgba(147, 197, 253, 0.68)")).a).toBeCloseTo(0.68, 2)
  })

  it("leaves anything that isn't written as a colour alone", () => {
    // Match labels and `get` keys share the expression with the colours.
    for (const value of ["interpolate", "zoom", "class", "park", "tan"]) {
      expect(darkenColor(value)).toBe(value)
    }
  })
})

for (const { key } of MAP_STYLES) {
  for (const theme of THEMES) {
    const style = mapStyleFor(key, theme)
    const ground = paintOf(style, "landuse_residential")["fill-color"] as string

    describe(`${key}, ${theme}`, () => {
      it("sits on an opaque ground, with opaque water", () => {
        // Anything translucent here lets the page behind the canvas through,
        // so the map would take on the UI's colour.
        for (const [layerId, prop] of [["background", "background-color"], ["water", "fill-color"]]) {
          expect(parse(paintOf(style, layerId)[prop] as string).a, layerId).toBe(1)
        }
      })

      it("makes streets stand off the ground more than buildings do", () => {
        const building = paintOf(style, "building")
        const fill = building["fill-color"] as string
        const opacity = (building["fill-opacity"] as number | undefined) ?? 1
        // A building is a soft tone, not an outlined shape.
        expect(building["fill-outline-color"]).toBe(fill)

        const road = evaluateLineLayerPaint(style, "road_minor", ZOOM)!.color
        const casing = evaluateLineLayerPaint(style, "road_minor_casing", ZOOM)!.color
        const effectiveBuilding = opacity * lightness(fill) + (1 - opacity) * lightness(ground)
        // A street reads by whichever of its fill and casing stands off the
        // ground more - on the light map that's the casing, since the fill is
        // white on near-white.
        const roadContrast = Math.max(
          Math.abs(lightness(road) - lightness(ground)),
          Math.abs(lightness(casing) - lightness(ground)),
        )
        const buildingContrast = Math.abs(effectiveBuilding - lightness(ground))
        expect(roadContrast).toBeGreaterThan(buildingContrast * 1.5)
        // And the street itself is never the building's colour: the two
        // being near-identical is what made a town read as one grey block.
        expect(Math.abs(lightness(road) - effectiveBuilding)).toBeGreaterThan(0.05)
      })

      it("gives every label an opaque halo that contrasts with its text", () => {
        for (const layer of style.layers) {
          if (layer.type !== "symbol" || !(layer.layout as Record<string, unknown> | undefined)?.["text-field"]) continue
          const paint = (layer.paint ?? {}) as Record<string, unknown>
          const text = paint["text-color"]
          // Shields and other labels drawn on an icon leave the text colour
          // to the icon; these are the ones that sit on the map itself.
          if (typeof text !== "string") continue
          const halo = paint["text-halo-color"]
          expect(typeof halo, `${layer.id} has no halo colour`).toBe("string")
          expect(parse(halo as string).a, layer.id).toBeGreaterThanOrEqual(0.5)
          expect(Math.abs(lightness(text) - lightness(halo as string)), layer.id).toBeGreaterThanOrEqual(0.3)
        }
      })

      it("writes every colour in a form MapLibre parses", () => {
        for (const layer of style.layers) {
          for (const [prop, value] of Object.entries((layer.paint ?? {}) as Record<string, unknown>)) {
            if (!prop.endsWith("-color")) continue
            for (const colour of colourStrings(value).filter((v) => /^(#|rgb|hsl)/.test(v))) {
              expect(Color.parse(colour), `${layer.id} ${prop}`).toBeDefined()
            }
          }
        }
      })
    })
  }

  describe(`${key}, dark only`, () => {
    const dark = mapStyleFor(key, "dark")
    const ground = lightness(paintOf(dark, "landuse_residential")["fill-color"] as string)

    it("sits on a dark ground", () => {
      expect(lightness(paintOf(dark, "background")["background-color"] as string)).toBeLessThan(0.3)
    })

    it("draws every road lighter than the ground", () => {
      // A road the base's automatic darkening reached first comes out
      // near-black - darker than the land around it, unlike every other road.
      const roads = dark.layers.filter(
        (l) =>
          l.type === "line" &&
          (l as { "source-layer"?: string })["source-layer"] === "transportation" &&
          !l.id.endsWith("_casing") &&
          !l.id.includes("rail"),
      )
      expect(roads.length).toBeGreaterThan(10)
      for (const layer of roads) {
        const { color } = evaluateLineLayerPaint(dark, layer.id, ZOOM)!
        expect(lightness(color), layer.id).toBeGreaterThan(ground)
      }
    })

    it("leaves no light sprite texture on the map", () => {
      const patterned = dark.layers.filter((l) => (l.paint as Record<string, unknown> | undefined)?.["fill-pattern"])
      expect(patterned.map((l) => l.id)).toEqual([])
    })

    it("leaves none of liberty's light fills in place", () => {
      const kept: string[] = []
      for (const layer of BASE_STYLE.layers) {
        const fill = (layer.paint as Record<string, unknown> | undefined)?.["fill-color"]
        if (typeof fill !== "string") continue
        if (paintOf(dark, layer.id)["fill-color"] === fill && lightness(fill) > 0.6) kept.push(layer.id)
      }
      expect(kept).toEqual([])
    })
  })
}

describe("hiking terrain", () => {
  it("gives every terrain kind a look of its own in the dark too", () => {
    const hiking = mapStyleFor("hiking", "dark")
    const shades = TERRAIN_FILLS.map(({ id }) => {
      const paint = paintOf(hiking, id)
      return `${paint["fill-color"]} ${paint["fill-opacity"]}`
    })
    expect(new Set(shades).size, shades.join(", ")).toBe(TERRAIN_FILLS.length)
  })
})

it("keeps each theme's style a single memoised object", () => {
  expect(mapStyleFor("hiking", "dark")).toBe(mapStyleFor("hiking", "dark"))
  expect(mapStyleFor("hiking", "dark")).not.toBe(mapStyleFor("hiking", "light"))
})
