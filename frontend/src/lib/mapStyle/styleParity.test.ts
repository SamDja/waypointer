import { createPropertyExpression, type Feature, type StyleSpecification } from "@maplibre/maplibre-gl-style-spec"
import { describe, expect, it } from "vitest"

import legacyRoadCycling from "./__fixtures__/road-cycling.legacy.json"
import { linePaintSpec } from "../mapStyleLegend"
import { composeStyle } from "./compose"
import { houseStyle } from "./houseStyle"
import { roadCyclingStyle } from "./roadCycling"

/**
 * Proves the composed road-cycling style still renders exactly like the
 * hand-edited road-cycling.json it replaces.
 *
 * The comparison is deliberately *semantic*, not a deep-equal against that
 * file: it evaluates both styles' paint expressions over a matrix of feature
 * tags and zooms, the same way MapLibre does when it draws a tile. A
 * deep-equal would also pin the shapes the old file happened to be written
 * in - two of its predicates are the same test nested differently, purely
 * from hand-editing - and would force the rewrite to carry that forward.
 * What has to stay identical is what a visitor sees.
 *
 * Once the legacy file is deleted this test goes with it; the style tests
 * that outlive it are the per-activity ones below it.
 */

const legacy = legacyRoadCycling as unknown as StyleSpecification
const composed = composeStyle(...houseStyle, ...roadCyclingStyle)

// Tag combinations that exercise every branch of both styles' predicates:
// permitted and forbidden access, paved and loose surfaces, tracks, and the
// untagged case that most ways in OSM actually are.
const FEATURE_TAGS: Record<string, unknown>[] = [
  {},
  { bicycle: "no" },
  { bicycle: "designated" },
  { access: "no" },
  { access: "no", bicycle: "permissive" },
  { access: "no", bicycle: "no" },
  { surface: "asphalt" },
  { surface: "gravel" },
  { surface: "cobblestone" },
  { surface: "compacted", bicycle: "designated" },
  { class: "track" },
  { class: "track", surface: "asphalt" },
  { class: "path", subclass: "cycleway" },
  { class: "path", bicycle: "designated" },
  { class: "pedestrian" },
  { class: "service" },
]

const ZOOMS = [8, 11, 12, 12.5, 13, 14, 15.5, 16, 18, 20]

const LINE_PAINT_PROPERTIES = ["line-color", "line-opacity", "line-width"] as const

function evaluate(
  style: StyleSpecification,
  layerId: string,
  property: (typeof LINE_PAINT_PROPERTIES)[number],
  zoom: number,
  properties: Record<string, unknown>,
): string | null {
  const layer = style.layers.find((l) => l.id === layerId)
  if (!layer || layer.type !== "line") return null
  const paint = (layer.paint ?? {}) as Record<string, unknown>
  const fallback = property === "line-color" ? "#000000" : 1
  const expression = createPropertyExpression(paint[property] ?? fallback, property, linePaintSpec(property))
  if (expression.result !== "success") return `UNPARSEABLE:${property}`
  const feature: Feature = { type: "LineString", properties }
  return String(expression.value.evaluate({ zoom }, feature))
}

describe("composed road-cycling style", () => {
  it("has the same layers, in the same order, as the file it replaces", () => {
    expect(composed.layers.map((l) => l.id)).toEqual(legacy.layers.map((l) => l.id))
  })

  it("keeps the same sources, sprite and glyphs", () => {
    expect(composed.sources).toEqual(legacy.sources)
    expect(composed.sprite).toEqual(legacy.sprite)
    expect(composed.glyphs).toEqual(legacy.glyphs)
  })

  it("renders every line layer identically across tags and zooms", () => {
    const differences: string[] = []
    for (const layer of legacy.layers) {
      if (layer.type !== "line") continue
      for (const properties of FEATURE_TAGS) {
        for (const zoom of ZOOMS) {
          for (const property of LINE_PAINT_PROPERTIES) {
            const before = evaluate(legacy, layer.id, property, zoom, properties)
            const after = evaluate(composed, layer.id, property, zoom, properties)
            if (before !== after) {
              differences.push(
                `${layer.id} ${property} @z${zoom} ${JSON.stringify(properties)}: ${before} -> ${after}`,
              )
            }
          }
        }
      }
    }
    expect(differences.slice(0, 20)).toEqual([])
  })

  it("matches every non-line layer outright", () => {
    // Fills, symbols and the background carry no activity judgement, so
    // nothing should have re-shaped them - a plain deep-equal is fair here.
    const byId = new Map(composed.layers.map((l) => [l.id, l]))
    for (const layer of legacy.layers) {
      if (layer.type === "line") continue
      expect(byId.get(layer.id), layer.id).toEqual(layer)
    }
  })
})
