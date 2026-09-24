import { featureFilter, validateStyleMin, type FilterSpecification } from "@maplibre/maplibre-gl-style-spec"
import { describe, expect, it } from "vitest"

import { MAP_STYLES, mapStyleFor } from "../mapStyles"
import { TERRAIN_FILLS } from "./hiking"
import { TERRAIN_PATTERNS } from "./terrainPatterns"
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

  it("draws paths in red and tracks in an earth tone, where cycling greys both out", () => {
    const trail = paint(hiking, "road_path_pedestrian")
    const track = paint(hiking, "road_track")

    // Red for paths is the convention walking maps share (Swisstopo, CAI
    // waymarks), so it has to actually be red rather than merely "not grey".
    const [, red, green, blue] = trail.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)!.map(Number)
    expect(red).toBeGreaterThan(150)
    expect(red).toBeGreaterThan(green * 2)
    expect(red).toBeGreaterThan(blue * 2)

    // A track is a vehicle way you happen to be walking on. Keeping it a
    // different hue is what tells the two apart - and neither may be the
    // pale grey that made tracks read as unavailable.
    expect(trail.color).not.toEqual(track.color)
    expect(trail.width).toBeGreaterThan(track.width)
    for (const { color, opacity } of [trail, track]) {
      expect(color).not.toMatch(/^rgba\(2(1[0-9]|[0-4][0-9]),/)
      expect(opacity).toBe(1)
    }

    expect(paint(cycling, "road_path_pedestrian").opacity).toBeLessThan(1)
  })

  it("keeps a paved path in the same hue as an unpaved one", () => {
    // Surface separates by lightness, not by hue: a made path is still a
    // path, and turning it a different colour would read as a different
    // kind of way.
    const unpaved = paint(hiking, "road_path_pedestrian")
    const paved = paint(hiking, "road_path_pedestrian", { surface: "paved" })
    expect(paved.color).not.toEqual(unpaved.color)
    const channels = (color: string) => color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)!.map(Number).slice(1)
    const [pr, pg, pb] = channels(paved.color)
    expect(pr).toBeGreaterThan(pg)
    expect(pr).toBeGreaterThan(pb)
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

  it("draws paths earlier and heavier than the base does, where it matters", () => {
    const layer = hiking.layers.find((l) => l.id === "road_path_pedestrian")!
    // The base doesn't draw paths at all below 14. Coming forward from 11 is
    // most of the point: that's where a walker is choosing between valleys.
    expect(layer.minzoom).toBeLessThan(14)

    // Compared at 14, the zoom the base finally starts at - which is where
    // "heavier than a hairline" actually means something. Further in, both
    // are thick enough that the weight stops carrying the difference and
    // the colour does, so this deliberately doesn't assert about z18.
    const at14 = (style: typeof hiking) => evaluateLineLayerPaint(style, "road_path_pedestrian", 14, {})!
    expect(at14(hiking).width).toBeGreaterThan(at14(cycling).width)
    // And the bike's is dimmed on top of being thinner.
    expect(at14(hiking).opacity).toBeGreaterThan(at14(cycling).opacity)
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

  describe("hiking landmarks", () => {
    // The layers are filtered, not styled, so what matters is which features
    // they select. Checked with the style spec's own filter evaluator, the
    // same one the renderer uses against a real tile.
    // Vector-tile geometry types, as the filters' `geometry-type` checks see
    // them. Defaults to a point, since most of these layers are POIs; the
    // road-name layers filter on LineString and would reject a point
    // outright.
    const POINT = 1
    const LINE = 2
    const selects = (layerId: string, properties: Record<string, unknown>, geometryType = POINT) => {
      const index = hiking.layers.findIndex((l) => l.id === layerId)
      // `filter` isn't on every layer type in the union (a background layer
      // has none), but every layer these tests name does have one.
      const layer = hiking.layers[index] as { filter?: FilterSpecification }
      const filter = featureFilter(layer.filter, `layers[${index}].filter`)
      return filter.filter({ zoom: 15 }, { type: geometryType, properties } as never)
    }

    it("shows signposts, mountain huts and shelters, and nothing else from the POI layer", () => {
      expect(selects("hiking_poi", { class: "information", subclass: "guidepost" })).toBe(true)
      expect(selects("hiking_poi", { class: "lodging", subclass: "alpine_hut" })).toBe(true)
      // Accepted if it ever arrives, but OpenMapTiles' tourism mapping has
      // no wilderness_hut, so this branch matches nothing in real tiles -
      // asserting it here would otherwise read as "we draw bivouacs".
      expect(selects("hiking_poi", { class: "lodging", subclass: "wilderness_hut" })).toBe(true)
      expect(selects("hiking_poi", { class: "shelter", subclass: "shelter" })).toBe(true)

      // A town hotel is the same OSM class as a mountain hut, so the
      // subclass is what has to carry the distinction.
      expect(selects("hiking_poi", { class: "lodging", subclass: "hotel" })).toBe(false)
      // An information board isn't a signpost.
      expect(selects("hiking_poi", { class: "information", subclass: "board" })).toBe(false)
      expect(selects("hiking_poi", { class: "restaurant", subclass: "restaurant" })).toBe(false)
      expect(selects("hiking_poi", { class: "hairdresser", subclass: "hairdresser" })).toBe(false)
    })

    it("separates peaks from passes, and draws neither on the cycling map", () => {
      expect(selects("mountain_peak_point", { class: "peak" })).toBe(true)
      expect(selects("mountain_peak_point", { class: "saddle" })).toBe(false)
      expect(selects("mountain_saddle_point", { class: "saddle" })).toBe(true)
      expect(selects("mountain_saddle_point", { class: "peak" })).toBe(false)
      // cliff shares the source-layer and is not a place you walk to.
      expect(selects("mountain_peak_point", { class: "cliff" })).toBe(false)

      const cyclingLayerIds = new Set(cycling.layers.map((l) => l.id))
      for (const id of ["hiking_poi", "mountain_peak_point", "mountain_saddle_point"]) {
        expect(cyclingLayerIds.has(id), id).toBe(false)
      }
    })

    it("fills terrain the base style leaves blank or lumps together", () => {
      expect(selects("landcover_scree", { class: "rock", subclass: "scree" })).toBe(true)
      expect(selects("landcover_bare_rock", { class: "rock", subclass: "bare_rock" })).toBe(true)
      expect(selects("landcover_scree", { class: "rock", subclass: "bare_rock" })).toBe(false)

      // The base draws no farmland at all, though it is most of what a
      // valley walk crosses - 60 features in one tile near Trento.
      expect(selects("landcover_farmland", { class: "farmland", subclass: "farmland" })).toBe(true)
      expect(selects("landcover_vineyard", { class: "farmland", subclass: "vineyard" })).toBe(true)

      // And it paints every green as one green: scrub is slow and scratchy
      // to cross, meadow is not, and both are class=grass in the tiles.
      expect(selects("landcover_scrub", { class: "grass", subclass: "scrub" })).toBe(true)
      expect(selects("landcover_grassland", { class: "grass", subclass: "meadow" })).toBe(true)
      expect(selects("landcover_grassland", { class: "grass", subclass: "scrub" })).toBe(false)
      expect(selects("landcover_scrub", { class: "grass", subclass: "meadow" })).toBe(false)
    })

    it("gives every terrain kind a look of its own", () => {
      const fill = (id: string) =>
        (hiking.layers.find((l) => l.id === id)!.paint as Record<string, unknown>)["fill-color"]
      const tinted = TERRAIN_FILLS.filter((entry) => entry.color !== undefined).map((entry) => entry.id)
      // Two kinds of ground that render identically are two kinds a walker
      // cannot tell apart, which is the whole point of the table.
      const shades = tinted.map(fill)
      expect(new Set(shades).size, shades.join(", ")).toBe(tinted.length)
    })

    it("builds a layer for every tinted entry, and none for a pattern-only one", () => {
      const layerIds = new Set(hiking.layers.map((l) => l.id))
      for (const { id, color } of TERRAIN_FILLS) {
        // Forest is pattern-only: the base's landcover_wood already fills
        // it, so a second tint layer would double-paint it.
        expect(layerIds.has(id), id).toBe(color !== undefined)
      }
      // Every pattern named here is one that actually gets registered.
      const registered = new Set(TERRAIN_PATTERNS.map((pattern) => pattern.id))
      for (const { id, patternId } of TERRAIN_FILLS) {
        if (patternId) expect(registered.has(patternId), id).toBe(true)
      }
    })

    it("draws the narrower terrain refinements over the broader ones", () => {
      // scrub refines grass and vineyard refines farmland; if the broad
      // layer drew last it would simply cover them up.
      const order = hiking.layers.map((l) => l.id)
      expect(order.indexOf("landcover_scrub")).toBeGreaterThan(order.indexOf("landcover_grassland"))
      expect(order.indexOf("landcover_vineyard")).toBeGreaterThan(order.indexOf("landcover_farmland"))
      // And all of them over the base's own landcover fills.
      expect(order.indexOf("landcover_farmland")).toBeGreaterThan(order.indexOf("landcover_grass"))
    })

    it("leaves the cycling map's ground alone", () => {
      const cyclingLayerIds = new Set(cycling.layers.map((l) => l.id))
      for (const { id, color } of TERRAIN_FILLS) {
        if (color !== undefined) expect(cyclingLayerIds.has(id), id).toBe(false)
      }
    })

    it("names the walking network and nothing else", () => {
      const layerIds = new Set(hiking.layers.map((l) => l.id))
      // Road names crowd out the one label that matters on foot, and label
      // roads the style is actively steering a walker away from.
      expect(layerIds.has("highway-name-major")).toBe(false)
      // Paths keep theirs untouched.
      expect(layerIds.has("highway-name-path")).toBe(true)
      // Tracks keep theirs - a forest road's name is how it's signed on the
      // ground - but the minor/service roads sharing that layer lose them.
      expect(selects("highway-name-minor", { class: "track" }, LINE)).toBe(true)
      expect(selects("highway-name-minor", { class: "minor" }, LINE)).toBe(false)
      expect(selects("highway-name-minor", { class: "service" }, LINE)).toBe(false)

      // The cycling map is unchanged: a road cyclist is on roads and wants
      // their names.
      const cyclingLayerIds = new Set(cycling.layers.map((l) => l.id))
      expect(cyclingLayerIds.has("highway-name-major")).toBe(true)
    })

    it("asks the sprite only for icons it actually has", () => {
      // icon-image resolves from the POI's `class`, and a name the sprite
      // doesn't carry renders nothing while logging once per feature. These
      // are the three classes HIKING_POI can select, plus the peak's own.
      const available = new Set(["information", "lodging", "shelter", "mountain"])
      const poiLayer = hiking.layers.find((l) => l.id === "hiking_poi")!
      expect((poiLayer.layout as Record<string, unknown>)["icon-image"]).toEqual(["get", "class"])
      for (const cls of ["information", "lodging", "shelter"]) expect(available.has(cls)).toBe(true)

      const peakLayer = hiking.layers.find((l) => l.id === "mountain_peak_point")!
      expect(available.has((peakLayer.layout as Record<string, string>)["icon-image"])).toBe(true)
    })
  })

  it("keeps the house palette on roads it has no opinion about", () => {
    // Nothing in the hiking patch touches an ordinary minor road, so it must
    // still be the house white rather than anything hiking-specific.
    expect(paint(hiking, "road_minor").color).toEqual(paint(cycling, "road_minor").color)
  })
})
