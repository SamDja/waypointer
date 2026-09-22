import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec"

import { forLayers, insertLayersAfter, removeLayer, setLayerProps, setLayout, setPaint, type StylePatch } from "./compose"

/**
 * Sulla Via's own cartography, applied to every activity (see compose.ts for
 * how the three stages fit together).
 *
 * Nothing here knows which activity is selected. It is the house look: a
 * muted basemap that lets the route line, the POI markers and the planner's
 * points carry the eye, and labels with enough contrast to stay readable
 * over it. An activity patch then dims and highlights on top.
 */

// Upstream liberty's road palette is a saturated yellow/orange road atlas -
// handsome on its own, but it competes with the route line drawn over it.
// These are the same roads in a muted version of the same hues, so the
// hierarchy (motorway > primary > secondary > minor) still reads.
const ROAD_PALETTE: Record<string, string> = {
  road_trunk_primary: "#fbd9a6",
  road_trunk_primary_casing: "#e8891f",
  road_secondary_tertiary: "#fbe9a0",
  road_secondary_tertiary_casing: "#c9a227",
  road_minor: "#ffffff",
  road_minor_casing: "#a39c90",
  road_link: "#f4dfc3",
  road_link_casing: "#d8b267",
  tunnel_trunk_primary: "#f4dfc3",
  tunnel_trunk_primary_casing: "#d8b267",
  tunnel_secondary_tertiary: "#f6f8d2",
  tunnel_secondary_tertiary_casing: "#b1bb5d",
  tunnel_minor: "#f6f6f6",
  tunnel_street_casing: "#888888",
  tunnel_link: "#f4dfc3",
  tunnel_link_casing: "#d8b267",
  bridge_trunk_primary: "#f4dfc3",
  bridge_trunk_primary_casing: "#d8b267",
  bridge_secondary_tertiary: "#f6f8d2",
  bridge_secondary_tertiary_casing: "#b1bb5d",
  bridge_street: "#f6f6f6",
  bridge_street_casing: "#888888",
  bridge_link: "#f4dfc3",
  bridge_link_casing: "#d8b267",
}

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

export const houseStyle: StylePatch[] = [
  // A pale wash rather than upstream's warm paper, so the greens and blues
  // of the map sit on something neutral.
  setPaint("background", { "background-color": "rgba(236, 252, 203, 0.73)" }),
  setPaint("water", { "fill-color": "rgba(147, 197, 253, 0.68)" }),
  setPaint("landuse_residential", { "fill-color": "#fbfbf9" }),
  setPaint("building", { "fill-color": "#f4f4f0", "fill-outline-color": "#d8d8d0" }),
  // Upstream stops drawing flat buildings at the zoom where building-3d
  // takes over; without that layer they have to keep going.
  setLayerProps("building", { maxzoom: undefined }),
  removeLayer("building-3d"),

  // Path and track names are the labels that matter most when following a
  // route, and upstream's low-contrast brown loses them over the wash above.
  setPaint("highway-name-path", {
    "text-color": "#1a1a1a",
    "text-halo-color": "#ffffff",
    "text-halo-width": 1.2,
  }),

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
    "text-color": "#666",
    "text-halo-blur": 0.5,
    "text-halo-color": "#ffffff",
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

  forLayers(Object.keys(ROAD_PALETTE), (layerId) => setPaint(layerId, { "line-color": ROAD_PALETTE[layerId] })),

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
