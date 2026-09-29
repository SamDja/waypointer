import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec"
import colors from "tailwindcss/colors"

import { tailwindHex } from "../color"
import type { MapTheme } from "../theme"
import {
  forLayers,
  insertLayersAfter,
  mapPaint,
  removeLayer,
  setLayerProps,
  setLayout,
  setPaint,
  type StylePatch,
} from "./compose"

/**
 * Sulla Via's own cartography, applied to every activity (see compose.ts for
 * how the three stages fit together).
 *
 * Nothing here knows which activity is selected. It is the house look: a
 * muted basemap that lets the route line, the POI markers and the planner's
 * points carry the eye, and labels with enough contrast to stay readable
 * over it. An activity patch then dims and highlights on top.
 */

const tw = tailwindHex

// Upstream liberty's road palette is a saturated yellow/orange road atlas -
// handsome on its own, but it competes with the route line drawn over it.
// These are the same roads in a muted version of the same hues, so the
// hierarchy (motorway > primary > secondary > minor > service) still reads.
//
// A bridge is a road in the open air, so it takes the road's own colours;
// only tunnels are drawn dimmer. Service roads (and, through them, the
// activities' dims) sit a step below minor streets.
const LIGHT_ROADS = {
  road_trunk_primary: tw(colors.orange[200]),
  road_trunk_primary_casing: tw(colors.orange[400]),
  road_secondary_tertiary: tw(colors.amber[200]),
  road_secondary_tertiary_casing: tw(colors.yellow[600]),
  road_minor: tw(colors.white),
  road_minor_casing: tw(colors.stone[400]),
  road_link: tw(colors.orange[100]),
  road_link_casing: tw(colors.orange[300]),
  road_service_track: tw(colors.white),
  road_service_track_casing: tw(colors.stone[300]),
  tunnel_trunk_primary: tw(colors.orange[100]),
  tunnel_trunk_primary_casing: tw(colors.orange[300]),
  tunnel_secondary_tertiary: tw(colors.amber[100]),
  tunnel_secondary_tertiary_casing: tw(colors.yellow[500]),
  tunnel_minor: tw(colors.stone[100]),
  tunnel_street_casing: tw(colors.stone[500]),
  tunnel_link: tw(colors.orange[100]),
  tunnel_link_casing: tw(colors.orange[300]),
  tunnel_service_track: tw(colors.stone[100]),
  tunnel_service_track_casing: tw(colors.stone[300]),
  bridge_trunk_primary: tw(colors.orange[200]),
  bridge_trunk_primary_casing: tw(colors.orange[400]),
  bridge_secondary_tertiary: tw(colors.amber[200]),
  bridge_secondary_tertiary_casing: tw(colors.yellow[600]),
  bridge_street: tw(colors.white),
  bridge_street_casing: tw(colors.stone[400]),
  bridge_link: tw(colors.orange[100]),
  bridge_link_casing: tw(colors.orange[300]),
  bridge_service_track: tw(colors.white),
  bridge_service_track_casing: tw(colors.stone[300]),
}

type RoadLayer = keyof typeof LIGHT_ROADS

// The same hierarchy on a dark ground. Roads now read by being *lighter*
// than the land around them, so each fill is the brighter step and its
// casing the darker one - the reverse of the light palette, where a white
// street is outlined in grey. Every fill stays lighter than the ground; a
// road that doesn't is one the base's automatic darkening got to first.
const DARK_ROADS: Record<RoadLayer, string> = {
  road_trunk_primary: tw(colors.amber[700]),
  road_trunk_primary_casing: tw(colors.amber[950]),
  road_secondary_tertiary: tw(colors.yellow[800]),
  road_secondary_tertiary_casing: tw(colors.yellow[950]),
  road_minor: tw(colors.stone[500]),
  road_minor_casing: tw(colors.stone[950]),
  road_link: tw(colors.amber[800]),
  road_link_casing: tw(colors.amber[950]),
  road_service_track: tw(colors.stone[600]),
  road_service_track_casing: tw(colors.stone[900]),
  tunnel_trunk_primary: tw(colors.amber[900]),
  tunnel_trunk_primary_casing: tw(colors.amber[800]),
  tunnel_secondary_tertiary: tw(colors.yellow[900]),
  tunnel_secondary_tertiary_casing: tw(colors.yellow[800]),
  tunnel_minor: tw(colors.stone[700]),
  tunnel_street_casing: tw(colors.stone[600]),
  tunnel_link: tw(colors.amber[900]),
  tunnel_link_casing: tw(colors.amber[800]),
  tunnel_service_track: tw(colors.stone[700]),
  tunnel_service_track_casing: tw(colors.stone[800]),
  bridge_trunk_primary: tw(colors.amber[700]),
  bridge_trunk_primary_casing: tw(colors.amber[950]),
  bridge_secondary_tertiary: tw(colors.yellow[800]),
  bridge_secondary_tertiary_casing: tw(colors.yellow[950]),
  bridge_street: tw(colors.stone[500]),
  bridge_street_casing: tw(colors.stone[950]),
  bridge_link: tw(colors.amber[800]),
  bridge_link_casing: tw(colors.amber[950]),
  bridge_service_track: tw(colors.stone[600]),
  bridge_service_track_casing: tw(colors.stone[900]),
}

/**
 * The map's text colours, by role, shared by every layer that draws a label
 * of ours - here, in the activity patches, in the contours and in RouteMap's
 * own overlay - so a label's weight means the same thing everywhere.
 * liberty's place and water labels are left to the base.
 *
 * - `strong`: the names a walker or rider follows (paths and tracks).
 * - `normal`: streets and landmarks.
 * - `muted`: background detail - POI names, contour elevations (and the
 *   contour lines themselves).
 * - `water`: rivers, lakes and seas, in the water's own hue.
 * - `halo`: behind all of them, the ground's own tone.
 */
export const LABELS: Record<MapTheme, { strong: string; normal: string; muted: string; water: string; halo: string }> = {
  light: {
    strong: tw(colors.stone[900]),
    normal: tw(colors.stone[700]),
    muted: tw(colors.stone[500]),
    water: tw(colors.blue[800]),
    halo: tw(colors.white),
  },
  dark: {
    strong: tw(colors.stone[100]),
    normal: tw(colors.stone[300]),
    muted: tw(colors.stone[400]),
    water: tw(colors.blue[300]),
    halo: tw(colors.stone[900]),
  },
}

// Buildings are a soft, flat tone just off the ground - drawn without an
// outline of their own (the outline is the fill) - so that in a town the
// roads, which are the only lighter-than-ground lines and keep the only hard
// edges, are what the eye follows.
const LIGHT = {
  // A pale wash rather than upstream's warm paper, so the greens and blues
  // of the map sit on something neutral. Opaque: a translucent background
  // lets the page behind the map canvas show through, so the map would take
  // on whatever colour the UI happened to be.
  background: tw(colors.lime[50]),
  water: tw(colors.blue[200]),
  residential: tw(colors.stone[100]),
  building: tw(colors.stone[200]),
  buildingOpacity: 0.5,
  roads: LIGHT_ROADS as Record<RoadLayer, string>,
  // Only the dark theme replaces liberty's sprite textures (see houseStyle).
  pedestrianArea: null as string | null,
  wetland: null as string | null,
}

const DARK: typeof LIGHT = {
  background: tw(colors.stone[900]),
  water: tw(colors.sky[950]),
  residential: tw(colors.stone[800]),
  building: tw(colors.stone[700]),
  buildingOpacity: 0.4,
  roads: DARK_ROADS,
  pedestrianArea: tw(colors.stone[700]),
  wetland: tw(colors.teal[900]),
}

// The road-name layers, which liberty gives a halo width but no halo colour
// - so, transparent: a street name sat straight on its own road.
const ROAD_NAME_LAYERS = ["highway-name-minor", "highway-name-major"]

// liberty draws river names in a pale blue on a translucent halo, which is
// barely legible on either map, and lake names in a different blue again.
const WATER_NAME_LAYERS = ["waterway_line_label", "water_name_point_label", "water_name_line_label"]


// Upstream draws tracks inside road_service_track, mixed in with service
// roads. Every activity wants to treat a track differently from a back
// alley - a road bike avoids it, a walker is happy on it - so the split
// itself is structural and belongs here; each activity patch then colours
// `road_track` its own way. Only the geometry-ish paint (width, dashes) is
// set here, since that says "this is a track" rather than "this is good or
// bad for you".
const TRACK_LAYER_BASE = {
  type: "line",
  source: "openmaptiles",
  "source-layer": "transportation",
  filter: ["all", ["match", ["get", "brunnel"], ["bridge", "tunnel"], false, true], ["==", ["get", "class"], "track"]],
  layout: { "line-cap": "round", "line-join": "round" },
} as const

const TRACK_LAYERS = [
  {
    ...TRACK_LAYER_BASE,
    id: "road_track_casing",
    paint: {
      "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 15, 1, 16, 4, 20, 11],
      "line-dasharray": [2, 1.5],
    },
  },
  {
    ...TRACK_LAYER_BASE,
    id: "road_track",
    paint: {
      "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 15.5, 0, 16, 2, 20, 7.5],
      "line-dasharray": [2, 1.5],
    },
  },
] as unknown as LayerSpecification[]


/**
 * Swaps a sprite texture for a flat fill. OpenFreeMap's sprite only comes in
 * light, so on the dark map its patterns would draw as bright tiles.
 */
const flatFill = (layerId: string, color: string, opacity: number): StylePatch =>
  mapPaint(layerId, (paint) => {
    const flat: Record<string, unknown> = { ...paint, "fill-color": color, "fill-opacity": opacity }
    delete flat["fill-pattern"]
    return flat
  })

export const houseStyle = (theme: MapTheme): StylePatch[] => {
  const palette = theme === "dark" ? DARK : LIGHT
  const labels = LABELS[theme]
  return [
    setPaint("background", { "background-color": palette.background }),
    setPaint("water", { "fill-color": palette.water }),
    setPaint("landuse_residential", { "fill-color": palette.residential }),
    setPaint("building", {
      "fill-color": palette.building,
      "fill-outline-color": palette.building,
      "fill-opacity": palette.buildingOpacity,
    }),
    // Upstream stops drawing flat buildings at the zoom where building-3d
    // takes over; without that layer they have to keep going.
    setLayerProps("building", { maxzoom: undefined }),
    removeLayer("building-3d"),
    ...(palette.pedestrianArea ? [flatFill("road_area_pattern", palette.pedestrianArea, 1)] : []),
    ...(palette.wetland ? [flatFill("landcover_wetland", palette.wetland, 0.4)] : []),

    // Path and track names are the labels that matter most when following a
    // route, and upstream's low-contrast brown loses them over the wash above.
    setPaint("highway-name-path", {
      "text-color": labels.strong,
      "text-halo-color": labels.halo,
      "text-halo-width": 1.2,
    }),
    ...ROAD_NAME_LAYERS.map((id) =>
      setPaint(id, { "text-color": labels.normal, "text-halo-color": labels.halo }),
    ),
    ...WATER_NAME_LAYERS.map((id) =>
      setPaint(id, { "text-color": labels.water, "text-halo-color": labels.halo }),
    ),

    // The basemap's own POI icons are drawn at size 0: they stay in the style
    // (so RouteMap can still hit-test them - clicking one is how a visitor
    // adds a POI the search didn't find, see basemapPoiMapping.ts) but never
    // compete visually with our own markers.
    setLayerProps("poi_r1", { minzoom: 14, maxzoom: 24 }),
    setLayout("poi_r1", {
      "icon-image": ["match", ["get", "subclass"], ["florist", "furniture"], ["get", "subclass"], ["get", "class"]],
      "text-anchor": "top",
      "text-field": [
        "case",
        ["has", "name:nonlatin"],
        ["concat", ["get", "name:latin"], "\n", ["get", "name:nonlatin"]],
        ["coalesce", ["get", "name_en"], ["get", "name"]],
      ],
      "text-font": ["Noto Sans Italic"],
      "text-max-width": 9,
      "text-offset": [0, 0.6],
      "text-size": 0,
      "icon-size": 0,
    }),
    setPaint("poi_r1", {
      "text-color": labels.muted,
      "text-halo-blur": 0.5,
      "text-halo-color": labels.halo,
      "text-halo-width": 1,
      "text-opacity": 1,
    }),
    setLayout("poi_transit", {
      "icon-image": ["to-string", ["get", "class"]],
      "icon-size": 0,
      "text-anchor": "left",
      "text-field": [
        "case",
        ["has", "name:nonlatin"],
        ["concat", ["get", "name:latin"], "\n", ["get", "name:nonlatin"]],
        ["coalesce", ["get", "name_en"], ["get", "name"]],
      ],
      "text-font": ["Noto Sans Italic"],
      "text-max-width": 9,
      "text-offset": [0.9, 0],
      "text-size": 12,
    }),

    forLayers(Object.keys(palette.roads), (layerId) =>
      setPaint(layerId, { "line-color": palette.roads[layerId as RoadLayer] }),
    ),

    // Tracks move out of road_service_track into their own pair of layers,
    // drawn immediately after the service roads they used to share.
    setLayerProps("road_service_track", {
      filter: ["all", ["match", ["get", "brunnel"], ["bridge", "tunnel"], false, true], ["==", ["get", "class"], "service"]],
    }),
    setLayerProps("road_service_track_casing", {
      filter: ["all", ["match", ["get", "brunnel"], ["bridge", "tunnel"], false, true], ["==", ["get", "class"], "service"]],
    }),
    insertLayersAfter("road_service_track_casing", TRACK_LAYERS[0]),
    insertLayersAfter("road_service_track", TRACK_LAYERS[1]),
  ]
}
