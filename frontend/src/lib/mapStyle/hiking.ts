import colors from "tailwindcss/colors"

import { tailwindHex } from "../color"
import {
  addSource,
  dimColorWhen,
  dimOpacityWhen,
  insertLayersBefore,
  setLayerProps,
  setPaint,
  type Expression,
  type StylePatch,
} from "./compose"
import { CONTOUR_SOURCE_ID, contourLayers, contourSource } from "./contours"

/**
 * The hiking activity patch: the walking network stands out, and what you
 * can't (or wouldn't want to) walk recedes.
 *
 * It makes the opposite call to roadCycling.ts on the same ways. Unpaved is
 * not a defect on foot - it's most of the point - so nothing here dims by
 * surface. What matters instead is whether a way is walkable at all, and
 * whether it's the kind of way you'd choose: a path, a track or a quiet
 * lane, rather than a trunk road with no verge.
 */

// Tracks and paths are what a walker actually follows, so they're the only
// things drawn in colour - a warm earth tone that reads as "unpaved" and
// stays clear of the violet route line drawn over it.
//
// Both take the same colour on purpose. A track is every bit as walkable as
// a path, so anything greyer here reads as "not for you" next to the amber
// - which is exactly how a muted stone tone looked in practice. They're
// told apart by weight and dash pattern instead: a path is the thicker,
// finer-dashed line, since a marked trail is what a walker is usually
// looking for.
const TRAIL = tailwindHex(colors.amber[700])
const TRACK = TRAIL

const DIM_FILL = tailwindHex(colors.neutral[300])
const DIM_CASING = "#a3a3a3" // neutral-400 in Tailwind v3; v4's oklch step resolves slightly lighter

// access=no is routinely paired with a foot tag that permits walking anyway
// (a private drive with a public right of way, a courtyard with
// foot=permissive), so a bare access=no only counts without such an
// override. `destination` is included where the bike profile has
// `customers`: on foot, "access to reach somewhere" is the walking case.
const FOOT_PERMITTED = ["yes", "designated", "permissive", "destination"]

const ACCESS_BLOCKED: Expression = [
  "any",
  ["==", ["get", "foot"], "no"],
  ["all", ["==", ["get", "access"], "no"], ["!", ["match", ["get", "foot"], FOOT_PERMITTED, true, false]]],
]

// Ordinary roads are perfectly walkable unless they say otherwise, so
// they're dimmed only by access - never by surface, and never for being
// minor.
const CONDITIONALLY_DIMMED = [
  "road_secondary_tertiary", "road_secondary_tertiary_casing",
  "road_minor", "road_minor_casing",
  "road_link", "road_link_casing",
  "road_service_track", "road_service_track_casing",
  "tunnel_secondary_tertiary", "tunnel_secondary_tertiary_casing",
  "tunnel_minor", "tunnel_street_casing",
  "tunnel_link", "tunnel_link_casing",
  "bridge_secondary_tertiary", "bridge_secondary_tertiary_casing",
  "bridge_street", "bridge_street_casing",
  "bridge_link", "bridge_link_casing",
  "bridge_service_track", "bridge_service_track_casing",
  "tunnel_service_track", "tunnel_service_track_casing",
]

// Motorways and trunk roads are dimmed outright rather than by tag. A
// motorway is closed to pedestrians everywhere, and a trunk road with
// traffic at 90km/h and no verge is one a walker should be steered away
// from whether or not anyone has tagged foot=no on it. They stay visible as
// landmarks - a walker still needs to see the road they're crossing.
const ALWAYS_DIMMED_FILL = [
  "road_motorway", "road_motorway_link", "road_trunk_primary",
  "tunnel_motorway", "tunnel_motorway_link", "tunnel_trunk_primary",
  "bridge_motorway", "bridge_motorway_link", "bridge_trunk_primary",
]
const ALWAYS_DIMMED_CASING = [
  "road_motorway_casing", "road_motorway_link_casing", "road_trunk_primary_casing",
  "tunnel_motorway_casing", "tunnel_motorway_link_casing", "tunnel_trunk_primary_casing",
  "bridge_motorway_casing", "bridge_motorway_link_casing", "bridge_trunk_primary_casing",
]

// Upstream draws paths as a thin white dashed hairline that only appears at
// zoom 14 - fine as a background detail on a road map, useless as the
// subject of the map. They come forward here: in colour, thicker, and from
// zoom 11, which is roughly where a walker starts choosing between valleys.
const PATH_LAYERS = ["road_path_pedestrian", "tunnel_path_pedestrian", "bridge_path_pedestrian"]
const TRAIL_WIDTH = ["interpolate", ["exponential", 1.2], ["zoom"], 11, 0.75, 14, 2, 20, 10]
const PATH_MIN_ZOOM = 11

/**
 * What kind of way it is, drawn as a dash pattern, and what it's made of,
 * drawn as a colour. Splitting the two means every combination reads
 * without needing a layer each: `line-dasharray` takes a feature
 * expression in this MapLibre version, so one layer covers all five path
 * subclasses.
 *
 * OpenMapTiles is the limit on how fine this can get. It normalises
 * `surface` all the way down to paved/unpaved - no gravel, dirt or rock -
 * and carries neither `tracktype` nor `sac_scale`, so a topo map's usual
 * grading of tracks by firmness isn't available from these tiles at all.
 */
const PATH_DASH: Expression = [
  "match",
  ["get", "subclass"],
  // Rungs, like a topo map draws stairs.
  "steps", ["literal", [0.6, 0.6]],
  // A made footway is a continuous thing underfoot, so a tight dash.
  "footway", ["literal", [3, 1]],
  // A pedestrian street is paving, not a trail - nearly solid.
  "pedestrian", ["literal", [6, 1]],
  "cycleway", ["literal", [4, 1.5]],
  // An unmade mountain path: the loosest dash, the one that reads as
  // "this is a line on the ground, not a surface".
  ["literal", [2, 1.5]],
]

// Unknown surface is drawn as unpaved: on a hiking map most untagged paths
// are, and promising a made surface that isn't there is the worse error.
const IS_PAVED: Expression = ["==", ["get", "surface"], "paved"]
const PAVED = tailwindHex(colors.stone[600])
const PATH_COLOR: Expression = ["case", IS_PAVED, PAVED, TRAIL]

// The track layers inherit a width ramp that only opens at zoom 15.5, from
// back when a track was something to notice late and avoid. Bringing them
// forward to PATH_MIN_ZOOM without this would draw them at zero width for
// four zoom levels - visible only as their own casing, which is precisely
// what "greyed out" looks like.
const TRACK_WIDTH = ["interpolate", ["exponential", 1.2], ["zoom"], 11, 0.6, 14, 1.5, 20, 7.5]
const TRACK_CASING_WIDTH = ["interpolate", ["exponential", 1.2], ["zoom"], 11, 1.4, 14, 3, 20, 11]

export const hikingStyle = (): StylePatch[] => [
  dimColorWhen(CONDITIONALLY_DIMMED, ACCESS_BLOCKED, (layerId) =>
    layerId.endsWith("_casing") ? DIM_CASING : DIM_FILL,
  ),
  dimOpacityWhen(CONDITIONALLY_DIMMED, ACCESS_BLOCKED),

  ...ALWAYS_DIMMED_FILL.map((id) => setPaint(id, { "line-color": DIM_FILL, "line-opacity": 0.6 })),
  ...ALWAYS_DIMMED_CASING.map((id) => setPaint(id, { "line-color": DIM_CASING, "line-opacity": 0.6 })),

  ...PATH_LAYERS.map((id) =>
    setPaint(id, { "line-color": PATH_COLOR, "line-width": TRAIL_WIDTH, "line-dasharray": PATH_DASH }),
  ),
  setLayerProps("road_path_pedestrian", { minzoom: PATH_MIN_ZOOM }),
  // The casing under a path bridge would otherwise stay the base's pale grey
  // and read as a gap in the trail.
  setPaint("bridge_path_pedestrian_casing", { "line-color": tailwindHex(colors.stone[300]) }),

  // houseStyle splits tracks into their own layers but leaves them
  // uncoloured, for exactly this reason: the bike dims them and a walker
  // wants them.
  // A track has no subclass to split on - OpenMapTiles gives it none - so
  // the only distinction available is what it's surfaced with. A paved
  // forest road is a different walk from a muddy one.
  setPaint("road_track", {
    "line-color": ["case", IS_PAVED, PAVED, TRACK],
    "line-width": TRACK_WIDTH,
    "line-dasharray": ["case", IS_PAVED, ["literal", [4, 1]], ["literal", [2, 1.5]]],
  }),
  setPaint("road_track_casing", {
    "line-color": ["case", IS_PAVED, PAVED, TRACK],
    "line-width": TRACK_CASING_WIDTH,
    "line-opacity": 0.25,
  }),
  setLayerProps("road_track", { minzoom: PATH_MIN_ZOOM }),
  setLayerProps("road_track_casing", { minzoom: PATH_MIN_ZOOM }),

  // Contours sit under everything else on the map, so the route line, the
  // trails and the markers all stay legible over them.
  addSource(CONTOUR_SOURCE_ID, contourSource()),
  insertLayersBefore("tunnel_motorway_casing", ...contourLayers()),
]
