import type { LayerSpecification, SourceSpecification } from "@maplibre/maplibre-gl-style-spec"
import * as maplibreModule from "maplibre-gl"
import mlcontour from "maplibre-contour"
import colors from "tailwindcss/colors"

import { tailwindHex } from "../color"

/**
 * Contour lines for the hiking style.
 *
 * OpenFreeMap's tiles carry no elevation at all - its TileJSON lists 16
 * layers and none of them is a contour - so the lines are derived in the
 * browser instead, by maplibre-contour, from public terrain-RGB tiles. It
 * registers a maplibre protocol that turns DEM tiles into ordinary vector
 * tiles of isolines, which the layers below then style like any other
 * source.
 *
 * Only the hiking style uses this. Nothing is fetched until a map actually
 * renders one of these layers, so the cycling style costs nothing for it.
 */

// AWS Open Data's "Terrain Tiles", the successor to Mapzen's - terrarium
// encoding, no API key, no usage ceiling published. maxzoom 15 is what the
// dataset actually holds; MapLibre overzooms past it rather than 404ing.
const DEM_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
const DEM_MAX_ZOOM = 15

// Required by the dataset's terms and the usual OSM-adjacent courtesy: the
// DEM is a composite of public sources, chiefly SRTM and various national
// surveys. Set on the source below, which is where MapLibre's own
// AttributionControl collects it from - so it appears next to OpenFreeMap's
// credit only while the hiking style is showing.
export const CONTOUR_ATTRIBUTION =
  '<a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (SRTM, NASADEM et al.)'

export const CONTOUR_SOURCE_ID = "contours"
const CONTOUR_LAYER = "contours"
const ELEVATION_KEY = "ele"
const LEVEL_KEY = "level"

// One DemSource per page, created lazily: constructing it spins up a shared
// web worker, and registering its protocol twice would throw.
let demSource: InstanceType<typeof mlcontour.DemSource> | null = null

function sharedDemSource() {
  if (!demSource) {
    demSource = new mlcontour.DemSource({
      url: DEM_TILES,
      encoding: "terrarium",
      maxzoom: DEM_MAX_ZOOM,
      // Off the UI thread: deriving isolines is real work, and the map is
      // usually being panned while it happens. Falls back to the main
      // thread where there's no Worker at all, which in practice means
      // composing the style under vitest.
      worker: typeof Worker !== "undefined",
    })
    // maplibre-gl exposes addProtocol as a named export, not off a default
    // one. Under vitest the module resolves without it, and nothing there
    // will ever request a contour tile, so registration is skipped rather
    // than faked.
    if (typeof maplibreModule.addProtocol === "function") {
      demSource.setupMaplibre(maplibreModule)
    }
  }
  return demSource
}

export function contourSource(): SourceSpecification {
  return {
    type: "vector",
    // Past the DEM's own zoom the lines stop gaining detail, so they're
    // overzoomed rather than recomputed.
    maxzoom: DEM_MAX_ZOOM,
    attribution: CONTOUR_ATTRIBUTION,
    tiles: [
      sharedDemSource().contourProtocolUrl({
        elevationKey: ELEVATION_KEY,
        levelKey: LEVEL_KEY,
        contourLayer: CONTOUR_LAYER,
        // Spacing per zoom, as [minor, major]: every 500m of elevation when
        // the whole massif is in view, down to every 10m once a single
        // valley fills the screen. Anything denser turns a steep slope into
        // a solid block of line.
        thresholds: {
          10: [500, 1000],
          11: [200, 1000],
          12: [100, 500],
          13: [50, 250],
          14: [20, 100],
          15: [10, 50],
        },
        // `overzoom` is left at its default of 0 deliberately. Raising it
        // trades resolution for fewer neighbour fetches, which is a good
        // deal for 512px DEM tiles - but these are 256px, so a quadrant of
        // a lower-zoom tile would be 128px of elevation behind each contour
        // tile, and the lines come out visibly blocky.
      }),
    ],
  } as SourceSpecification
}

// Contours belong behind everything a walker is actually navigating by, so
// they're inserted under the road casings rather than over them, and drawn
// in a brown that reads as terrain rather than competing with the amber
// paths.
const CONTOUR_COLOR = tailwindHex(colors.stone[500])
const MAJOR = ["==", ["get", LEVEL_KEY], 1]

export function contourLayers(): LayerSpecification[] {
  return [
    {
      id: "contour_line",
      type: "line",
      source: CONTOUR_SOURCE_ID,
      "source-layer": CONTOUR_LAYER,
      minzoom: 10,
      paint: {
        "line-color": CONTOUR_COLOR,
        // Every fifth line carries the elevation label, so it's drawn
        // heavier - the standard topographic index-contour convention.
        "line-width": ["case", MAJOR, 1, 0.5],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.2, 12, 0.4],
      },
    },
    {
      id: "contour_label",
      type: "symbol",
      source: CONTOUR_SOURCE_ID,
      "source-layer": CONTOUR_LAYER,
      // Only the index lines are labelled, and only once there's room.
      filter: MAJOR,
      minzoom: 12,
      layout: {
        "symbol-placement": "line",
        "text-field": ["concat", ["number-format", ["get", ELEVATION_KEY], {}], " m"],
        "text-font": ["Noto Sans Italic"],
        "text-size": 10,
        "text-max-angle": 25,
      },
      paint: {
        "text-color": CONTOUR_COLOR,
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.2,
      },
    },
  ] as unknown as LayerSpecification[]
}
