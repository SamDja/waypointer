import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec"
import colors from "tailwindcss/colors"

import { tailwindHex } from "../color"
import type { MapTheme } from "../theme"
import {
  dimColorWhen,
  dimOpacityWhen,
  insertLayersAfter,
  setLayerProps,
  setPaint,
  type Expression,
  type StylePatch,
} from "./compose"

/**
 * The road-cycling activity patch: what a road bike can't ride recedes, and
 * dedicated cycling infrastructure stands out.
 *
 * Everything here is the activity's judgement and nothing else - the palette
 * it dims *from* lives in houseStyle.ts. Compare hiking.ts, which makes the
 * opposite call on the same ways: unpaved is a problem here and unremarkable
 * on foot.
 */

// access=no is often paired with an explicit bicycle tag that permits
// cycling anyway (a pedestrian street a bike may walk through, a private
// road with bicycle=permissive), so a bare access=no only counts when no
// such override is present.
const BICYCLE_PERMITTED = ["yes", "designated", "permissive", "dismount", "customers"]

const ACCESS_BLOCKED: Expression = [
  "any",
  ["==", ["get", "bicycle"], "no"],
  ["all", ["==", ["get", "access"], "no"], ["!", ["match", ["get", "bicycle"], BICYCLE_PERMITTED, true, false]]],
]

// Anything a road bike shouldn't be on. cobblestone and sett are in here
// with the loose surfaces: they're rideable, but not on 25mm tyres at speed.
const UNPAVED: Expression = [
  "match",
  ["get", "surface"],
  [
    "gravel", "dirt", "ground", "unpaved", "sand", "grass", "mud", "compacted",
    "fine_gravel", "pebblestone", "earth", "dirt/sand", "cobblestone", "sett", "wood", "woodchips",
  ],
  true,
  false,
]

const UNSUITABLE: Expression = ["any", ACCESS_BLOCKED, UNPAVED]

// The bridge/tunnel service layers still carry tracks (only the surface-level
// ones were split out into road_track), so for those a track counts as
// unsuitable on its own, whatever its surface tag says.
const UNSUITABLE_OR_TRACK: Expression = ["any", ACCESS_BLOCKED, UNPAVED, ["==", ["get", "class"], "track"]]

// A dimmed way keeps its two-tone structure so it still reads as a road:
// the casing goes to the darker grey, the fill it outlines to the lighter
// one.
const LIGHT = {
  dimCasing: "#a3a3a3",
  dimFill: "#d4d4d4",
  motorwayFill: "#d4d4d4",
  motorwayCasing: "#a3a3a3",
  pedestrian: "#a3a3a3",
  pedestrianBridgeCasing: "#cfcdca",
  track: "#a6a09b",
  cycleway: "#009966",
}

// On a dark ground "recede" means sinking towards the background, so the
// dims are dark greys rather than light ones - still two-tone, casing below
// fill. The cycleway goes a step lighter so it still stands out.
const DARK: typeof LIGHT = {
  dimCasing: tailwindHex(colors.neutral[800]),
  dimFill: tailwindHex(colors.neutral[700]),
  motorwayFill: tailwindHex(colors.neutral[700]),
  motorwayCasing: tailwindHex(colors.neutral[800]),
  pedestrian: tailwindHex(colors.stone[500]),
  pedestrianBridgeCasing: tailwindHex(colors.stone[700]),
  track: tailwindHex(colors.stone[500]),
  cycleway: tailwindHex(colors.emerald[500]),
}

type Palette = typeof LIGHT

// Three layers dim to a shade of their own. Nothing distinguishes them -
// they're hand-editing drift from when this was a 12k-line file - and
// road_minor_casing dimming to white in particular makes a minor road's
// outline vanish rather than recede. Reproduced here so this refactor
// changes nothing visible; worth correcting deliberately, on its own. The
// dark palette has no such history, so it doesn't reproduce them.
const DIM_EXCEPTIONS: Record<string, string> = {
  road_minor: "#abab9c",
  road_minor_casing: "#ffffff",
  road_trunk_primary: "#d6d3d1",
}

const dimColorFor = (palette: Palette, exceptions: Record<string, string>) => (layerId: string): string =>
  exceptions[layerId] ?? (layerId.endsWith("_casing") ? palette.dimCasing : palette.dimFill)

// Roads that dim only when they're actually unsuitable - the ordinary case,
// where the tags decide.
const CONDITIONALLY_DIMMED = [
  "road_trunk_primary", "road_trunk_primary_casing",
  "road_secondary_tertiary", "road_secondary_tertiary_casing",
  "road_minor", "road_minor_casing",
  "road_link", "road_link_casing",
  "road_service_track", "road_service_track_casing",
  "tunnel_trunk_primary", "tunnel_trunk_primary_casing",
  "tunnel_secondary_tertiary", "tunnel_secondary_tertiary_casing",
  "tunnel_minor", "tunnel_street_casing",
  "tunnel_link", "tunnel_link_casing",
  "bridge_trunk_primary", "bridge_trunk_primary_casing",
  "bridge_secondary_tertiary", "bridge_secondary_tertiary_casing",
  "bridge_street", "bridge_street_casing",
  "bridge_link", "bridge_link_casing",
]

const TRACK_AWARE_DIMMED = [
  "tunnel_service_track", "tunnel_service_track_casing",
  "bridge_service_track", "bridge_service_track_casing",
]

// Motorways are never ridden, so they're greyed outright rather than
// conditionally - but they keep a conditional *opacity*, so a motorway
// explicitly tagged bicycle=no fades further still and the rest stay legible
// as landmarks.
const MOTORWAY_FILL = ["road_motorway", "road_motorway_link", "tunnel_motorway", "tunnel_motorway_link", "bridge_motorway", "bridge_motorway_link"]
const MOTORWAY_CASING = [
  "road_motorway_casing", "road_motorway_link_casing",
  "tunnel_motorway_casing", "tunnel_motorway_link_casing",
  "bridge_motorway_casing", "bridge_motorway_link_casing",
]
// One more drift of the same kind as DIM_EXCEPTIONS, light only.
const LIGHT_MOTORWAY_CASING_EXCEPTIONS: Record<string, string> = { road_motorway_casing: "#a6a09b" }

// Footpaths and pedestrian streets are always dim here: a road bike has no
// business on them regardless of surface. The cycleway layers below then
// pull the ones that *are* cycling infrastructure back out.
const PEDESTRIAN = ["road_path_pedestrian", "tunnel_path_pedestrian", "bridge_path_pedestrian"]
// The same drift again: light's surface-level footpath is a warmer grey.
const LIGHT_PEDESTRIAN_EXCEPTIONS: Record<string, string> = { road_path_pedestrian: "#a6a09b" }

// OpenMapTiles files OSM's highway=cycleway under class=path, so the
// pedestrian layers above would otherwise swallow it. Excluded there,
// redrawn here in green at every zoom - spotting dedicated infrastructure
// while still planning is the whole point, not something to discover at
// street level.
const CYCLEWAY_FILTER = (brunnel: Expression): Expression => [
  "all",
  ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
  brunnel,
  ["==", ["get", "class"], "path"],
  ["any", ["==", ["get", "subclass"], "cycleway"], ["==", ["get", "bicycle"], "designated"]],
]

const NOT_CYCLEWAY: Expression = [
  "all",
  ["!=", ["get", "subclass"], "cycleway"],
  ["!=", ["get", "bicycle"], "designated"],
]

const cyclewayLayer = (id: string, brunnel: Expression, color: string): LayerSpecification =>
  ({
    id,
    type: "line",
    source: "openmaptiles",
    "source-layer": "transportation",
    filter: CYCLEWAY_FILTER(brunnel),
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": color,
      "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 10, 0.75, 14, 2, 20, 9],
    },
  }) as unknown as LayerSpecification

const pedestrianFilter = (brunnel: Expression): Expression => [
  "all",
  ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
  brunnel,
  ["match", ["get", "class"], ["path", "pedestrian"], true, false],
  NOT_CYCLEWAY,
]

const SURFACE_LEVEL: Expression = ["match", ["get", "brunnel"], ["bridge", "tunnel"], false, true]
const IS_TUNNEL: Expression = ["==", ["get", "brunnel"], "tunnel"]
const IS_BRIDGE: Expression = ["==", ["get", "brunnel"], "bridge"]

export const roadCyclingStyle = (theme: MapTheme): StylePatch[] => {
  const palette = theme === "dark" ? DARK : LIGHT
  const light = theme === "light"
  const dimColor = dimColorFor(palette, light ? DIM_EXCEPTIONS : {})
  const motorwayCasing = (id: string) =>
    (light ? LIGHT_MOTORWAY_CASING_EXCEPTIONS[id] : undefined) ?? palette.motorwayCasing
  const pedestrian = (id: string) => (light ? LIGHT_PEDESTRIAN_EXCEPTIONS[id] : undefined) ?? palette.pedestrian

  return [
    dimColorWhen(CONDITIONALLY_DIMMED, UNSUITABLE, dimColor),
    dimOpacityWhen(CONDITIONALLY_DIMMED, UNSUITABLE),
    dimColorWhen(TRACK_AWARE_DIMMED, UNSUITABLE_OR_TRACK, dimColor),
    dimOpacityWhen(TRACK_AWARE_DIMMED, UNSUITABLE_OR_TRACK),

    ...MOTORWAY_FILL.map((id) => setPaint(id, { "line-color": palette.motorwayFill })),
    ...MOTORWAY_CASING.map((id) => setPaint(id, { "line-color": motorwayCasing(id) })),
    dimOpacityWhen([...MOTORWAY_FILL, ...MOTORWAY_CASING], UNSUITABLE),

    ...PEDESTRIAN.map((id) => setPaint(id, { "line-color": pedestrian(id), "line-opacity": 0.5 })),
    setPaint("bridge_path_pedestrian_casing", { "line-color": palette.pedestrianBridgeCasing, "line-opacity": 0.5 }),
    setLayerProps("road_path_pedestrian", { filter: pedestrianFilter(SURFACE_LEVEL) }),
    setLayerProps("tunnel_path_pedestrian", { filter: pedestrianFilter(IS_TUNNEL) }),
    setLayerProps("bridge_path_pedestrian", { filter: pedestrianFilter(IS_BRIDGE) }),

    // Unpaved by definition, so they take the same dim treatment as any
    // unsuitable road rather than the neutral look houseStyle gives them.
    setPaint("road_track", { "line-color": palette.track, "line-opacity": 0.5 }),
    setPaint("road_track_casing", { "line-color": palette.track, "line-opacity": 0.5 }),

    insertLayersAfter("road_motorway_casing", cyclewayLayer("cycleway", SURFACE_LEVEL, palette.cycleway)),
    insertLayersAfter("tunnel_motorway_casing", cyclewayLayer("tunnel_cycleway", IS_TUNNEL, palette.cycleway)),
    insertLayersAfter("bridge_street_casing", cyclewayLayer("bridge_cycleway", IS_BRIDGE, palette.cycleway)),
  ]
}
