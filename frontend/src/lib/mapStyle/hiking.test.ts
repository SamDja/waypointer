import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec"
import { describe, expect, it } from "vitest"

import { MAP_STYLES, mapStyleFor } from "../mapStyles"
import { evaluateLineLayerPaint } from "../mapStyleLegend"

/**
 * The hiking style's judgements, asserted through the same expression
 * engine that draws the map - so these check what a walker actually sees,
 * not how the patch happens to be written.
 *
 * The point of most of them is the contrast with road cycling: the two
 * activities look at the same tags and disagree.
 */

const hiking = mapStyleFor("hiking")
const cycling = mapStyleFor("road_cycling")

const ZOOM = 16

const PATH_LAYERS_UNDER_TEST = ["road_path_pedestrian", "bridge_path_pedestrian", "tunnel_path_pedestrian"]

const paint = (style: typeof hiking, layerId: string, properties: Record<string, unknown> = {}) => {
  const result = evaluateLineLayerPaint(style, layerId, ZOOM, properties)
  if (!result) throw new Error(`no line paint for ${layerId}`)
  return result
}

describe("hiking style", () => {
  it("never dims a road for being unpaved, where cycling does", () => {
    const gravel = { surface: "gravel" }
    expect(paint(hiking, "road_minor", gravel)).toEqual(paint(hiking, "road_minor"))
    // The same road, same tag, is dimmed on the bike's map.
    expect(paint(cycling, "road_minor", gravel)).not.toEqual(paint(cycling, "road_minor"))
  })

  it("dims a road closed to walkers, and ignores a bicycle=no that isn't", () => {
    expect(paint(hiking, "road_minor", { foot: "no" }).opacity).toBeLessThan(1)
    expect(paint(hiking, "road_minor", { bicycle: "no" })).toEqual(paint(hiking, "road_minor"))
  })

  it("respects a foot override on an access=no way", () => {
    expect(paint(hiking, "road_minor", { access: "no" }).opacity).toBeLessThan(1)
    expect(paint(hiking, "road_minor", { access: "no", foot: "permissive" })).toEqual(paint(hiking, "road_minor"))
  })

  it("dims motorways and trunk roads whatever their tags say", () => {
    for (const layerId of ["road_motorway", "road_trunk_primary"]) {
      expect(paint(hiking, layerId).opacity, layerId).toBeLessThan(1)
      expect(paint(hiking, layerId, { foot: "yes" }).opacity, layerId).toBeLessThan(1)
    }
  })

  it("draws paths and tracks in colour, where cycling greys them out", () => {
    const trail = paint(hiking, "road_path_pedestrian")
    const track = paint(hiking, "road_track")
    // The same amber for both - a track is as walkable as a path, and a
    // greyer tone for it reads as "not for you". They differ by weight.
    expect(trail.color).toEqual(track.color)
    expect(trail.width).toBeGreaterThan(track.width)
    for (const { color, opacity } of [trail, track]) {
      expect(color).not.toMatch(/^rgba\(2(1[0-9]|[0-4][0-9]),/) // not a pale grey
      expect(opacity).toBe(1)
    }
    expect(paint(cycling, "road_path_pedestrian").opacity).toBeLessThan(1)
  })

  it("actually draws the walking network at every zoom it claims to", () => {
    // A layer brought forward with `minzoom` but left on a width ramp that
    // opens later renders at zero width - present, invisible, and showing
    // only its own pale casing. That looked exactly like the network being
    // greyed out, and is easy to reintroduce when a width is tuned.
    for (const layerId of [...PATH_LAYERS_UNDER_TEST, "road_track", "road_track_casing"]) {
      const layer = hiking.layers.find((l) => l.id === layerId)!
      const from = layer.minzoom ?? 11
      for (const zoom of [from, from + 1, 14, 16, 18]) {
        const result = evaluateLineLayerPaint(hiking, layerId, zoom, {})!
        expect(result.width, `${layerId} @z${zoom}`).toBeGreaterThan(0)
        expect(result.opacity, `${layerId} @z${zoom}`).toBeGreaterThan(0)
      }
    }
  })

  it("draws paths wider than the base's hairline, and before zoom 14", () => {
    expect(paint(hiking, "road_path_pedestrian").width).toBeGreaterThan(
      paint(cycling, "road_path_pedestrian").width,
    )
    const layer = hiking.layers.find((l) => l.id === "road_path_pedestrian")!
    expect(layer.minzoom).toBeLessThan(14)
  })

  it("composes a style MapLibre itself considers valid, for every activity", () => {
    // The patches build expressions by hand, so this runs each finished
    // style through MapLibre's own validator - the same checks the map
    // would fail on at runtime, where a bad expression means a blank map
    // and a console error rather than a test failure.
    for (const { key } of MAP_STYLES) {
      const style = mapStyleFor(key)
      expect(validateStyleMin(style).map((e) => `${e.message}`), key).toEqual([])
    }
  })

  it("leaves no line layer without a colour, in any activity", () => {
    // houseStyle inserts the track layers with width and dashes but no
    // colour, deliberately - each activity colours them its own way. A
    // future activity that forgot would get MapLibre's default black, which
    // is loud and easy to miss in review.
    for (const { key } of MAP_STYLES) {
      const style = mapStyleFor(key)
      const uncoloured = style.layers
        .filter((l) => l.type === "line" && (l.paint as Record<string, unknown> | undefined)?.["line-color"] == null)
        .map((l) => l.id)
      expect(uncoloured, key).toEqual([])
    }
  })

  it("keeps the house palette on roads it has no opinion about", () => {
    // Nothing in the hiking patch touches an ordinary minor road, so it must
    // still be the house white rather than anything hiking-specific.
    expect(paint(hiking, "road_minor").color).toEqual(paint(cycling, "road_minor").color)
  })
})
