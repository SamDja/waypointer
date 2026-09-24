import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec"
import colors from "tailwindcss/colors"

import { tailwindHex } from "../color"
import {
  addSource,
  dimColorWhen,
  dimOpacityWhen,
  insertLayersAfter,
  insertLayersBefore,
  removeLayer,
  setLayerProps,
  setPaint,
  type Expression,
  type StylePatch,
} from "./compose"
import { CONTOUR_SOURCE_ID, contourLayers, contourSource } from "./contours"
import {
  BARE_ROCK_PATTERN_ID,
  FOREST_PATTERN_ID,
  SCREE_PATTERN_ID,
  SCRUB_PATTERN_ID,
  VINEYARD_PATTERN_ID,
} from "./terrainPatterns"

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
// things drawn in colour.
//
// Paths are red, which is the convention every serious walking map follows
// - Swisstopo, the CAI's own waymarks, and the topo styles modelled on them
// - so a walker reads it without being taught. Tracks keep the earth tone:
// a forest road is a vehicle way you happen to be walking on, not a trail,
// and the two being different colours is what tells them apart at a glance
// now that neither is grey.
const TRAIL = tailwindHex(colors.red[700])
// A made path is still a path, so it stays in the same hue and separates by
// lightness rather than by turning into a different kind of thing.
const PAVED_TRAIL = tailwindHex(colors.red[400])
const TRACK = tailwindHex(colors.amber[700])
// Same idea on the track side: a surfaced forest road is lighter, not a
// different colour.
const PAVED_TRACK = tailwindHex(colors.amber[500])

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
const TRAIL_WIDTH = ["interpolate", ["exponential", 1.2], ["zoom"], 11, 0.6, 14, 1.6, 20, 8]
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
const PATH_COLOR: Expression = ["case", IS_PAVED, PAVED_TRAIL, TRAIL]

// The track layers inherit a width ramp that only opens at zoom 15.5, from
// back when a track was something to notice late and avoid. Bringing them
// forward to PATH_MIN_ZOOM without this would draw them at zero width for
// four zoom levels - visible only as their own casing, which is precisely
// what "greyed out" looks like.
const TRACK_WIDTH = ["interpolate", ["exponential", 1.2], ["zoom"], 11, 0.45, 14, 1.15, 20, 6]
const TRACK_CASING_WIDTH = ["interpolate", ["exponential", 1.2], ["zoom"], 11, 1.1, 14, 2.3, 20, 8.5]

/**
 * The landmarks a walker navigates by, which the base style either buries or
 * never draws.
 *
 * houseStyle suppresses the basemap's own POI icons to `icon-size: 0` - they
 * exist only as click targets for "add this POI to my route". Rather than
 * lifting that suppression wholesale, which would bring back every
 * restaurant and hairdresser, these are separate layers filtered to the
 * handful of things that matter on foot.
 *
 * Icons come from OpenFreeMap's sprite, which is keyed by the POI's `class`:
 * a guidepost is class `information`, a mountain hut is `lodging`, a shelter
 * is `shelter`. It has no guidepost or hut icon of its own, so those two
 * borrow a generic one - worth replacing with real icons later, the way
 * RouteDirectionArrows registers its arrowhead at runtime.
 */
const HIKING_POI: Expression = [
  "any",
  // Signposts. Dense where they exist - 36 in one valley tile near Trento -
  // so they wait a zoom longer than the rest (see HIKING_POI_MIN_ZOOM).
  ["all", ["==", ["get", "class"], "information"], ["==", ["get", "subclass"], "guidepost"]],
  // `wilderness_hut` is listed defensively and matches nothing today:
  // OpenMapTiles' POI mapping accepts only alpine_hut, hotel, guest_house,
  // hostel and chalet under tourism, so an unstaffed bivouac never reaches
  // these tiles at all - confirmed against the schema and by scanning eight
  // alpine tiles. Our own PostGIS *does* import them (poi_types.py's
  // `lodging` filter), so they're findable by searching, and RouteMap's
  // MapPoiOverlay draws them from there (/api/map-pois).
  ["match", ["get", "subclass"], ["alpine_hut", "wilderness_hut"], true, false],
  ["==", ["get", "class"], "shelter"],
]

const HIKING_POI_MIN_ZOOM = 13
const PEAK_MIN_ZOOM = 11

/**
 * Ground a walker has to plan around. The base style fills wood, grass, ice,
 * wetland and sand, and draws `class=rock` not at all - so above the
 * treeline its map goes blank exactly where the going gets hardest.
 *
 * Flat tints for now. A topo map stipples scree and hatches bare rock, which
 * needs a `fill-pattern`, which needs an image in the sprite that
 * OpenFreeMap's doesn't carry - so it would mean generating the patterns at
 * runtime and registering them the way RouteDirectionArrows registers its
 * arrowhead. Worth doing, but the texture is the kind of thing that has to
 * be seen to be judged, so it isn't being guessed at here.
 */
const byClass = (cls: string): Expression => ["==", ["get", "class"], cls]
const bySubclass = (cls: string, ...subclasses: string[]): Expression => [
  "all",
  byClass(cls),
  ["match", ["get", "subclass"], subclasses, true, false],
]

/**
 * The ground itself, told apart.
 *
 * The base style paints landcover by `class` alone: every kind of green is
 * one green, so forest, scrub, meadow and pasture are indistinguishable -
 * and farmland isn't drawn at all, despite being most of what a valley
 * walk crosses. On foot the difference is the walk: forest is shade and no
 * view, scrub is slow and scratchy, a vineyard usually has no way through,
 * scree is loose underfoot.
 *
 * Each entry is a tint plus, where texture earns its keep, a generated
 * pattern drawn over it (see terrainPatterns.ts). Order matters: later
 * entries draw over earlier ones, so the narrower subclass layers come
 * after the broad class ones they refine.
 */
export const TERRAIN_FILLS: {
  id: string
  filter: Expression
  // Omitted where the base style already fills this ground and only the
  // texture is being added - see the forest entry.
  color?: string
  opacity?: number
  patternId?: string
}[] = [
    // Forest gets its tint from the base's own landcover_wood (recoloured
    // below); this entry exists only to lay canopy texture over it.
    {
      id: "landcover_forest",
      filter: byClass("wood"),
      patternId: FOREST_PATTERN_ID,
      opacity: 0.4
    },
    // Cultivated ground, which the base style leaves blank. Warm, to separate
    // the worked valley floor from the green of rough grazing above it.
    {
      id: "landcover_farmland",
      filter: byClass("farmland"),
      color: tailwindHex(colors.yellow[100]),
      opacity: 0.4,
    },
    {
      id: "landcover_vineyard",
      filter: bySubclass("farmland", "vineyard", "orchard", "plant_nursery"),
      color: tailwindHex(colors.amber[100]),
      opacity: 0.6,
      patternId: VINEYARD_PATTERN_ID,
    },
    // Open grazing and meadow: the easiest ground there is, so it stays a
    // plain wash with no texture competing with the route line.
    {
      id: "landcover_grassland",
      filter: bySubclass("grass", "grassland", "meadow", "pasture", "heath"),
      color: tailwindHex(colors.lime[100]),
      opacity: 0.4,
    },
    // Scrub is not grass to walk through, whatever the tiles say by lumping
    // them in one class.
    {
      id: "landcover_scrub",
      filter: bySubclass("grass", "scrub"),
      color: tailwindHex(colors.lime[200]),
      opacity: 0.5,
      patternId: SCRUB_PATTERN_ID,
    },
    // Loose stone: the paler of the two rocks, since it's the more common
    // ground and shouldn't dominate a whole cirque. Stippled.
    {
      id: "landcover_scree",
      filter: bySubclass("rock", "scree"),
      color: tailwindHex(colors.stone[200]),
      opacity: 0.85,
      patternId: SCREE_PATTERN_ID,
    },
    // Solid rock and cliff faces: darker and hatched, so the difference
    // between "slow going" and "not walkable" reads at a glance.
    {
      id: "landcover_bare_rock",
      filter: bySubclass("rock", "bare_rock"),
      color: tailwindHex(colors.stone[400]),
      opacity: 0.55,
      patternId: BARE_ROCK_PATTERN_ID,
    },
  ]

// The layer the terrain fills sit directly beneath, which is also where the
// pattern overlays have to be inserted so they land on top of their own
// tint and still under every road.
export const TERRAIN_BEFORE_ID = "landuse_pitch"

const terrainLayers = (): LayerSpecification[] =>
  TERRAIN_FILLS.filter(({ color }) => color !== undefined).map(({ id, filter, color, opacity }) => ({
    id,
    type: "fill",
    source: "openmaptiles",
    "source-layer": "landcover",
    filter,
    // The flat tint is the floor: it renders immediately and with no
    // dependency on an image, so terrain is never simply missing while the
    // pattern images are being registered (or if that fails outright).
    paint: { "fill-color": color, "fill-opacity": opacity, "fill-antialias": false },
  })) as unknown as LayerSpecification[]

const LABEL_COLOR = tailwindHex(colors.stone[700])
const IS_POINT: Expression = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false]

// A peak is worth its elevation; a name alone doesn't say whether it's the
// one you're aiming for. `ele` is missing often enough to need the fallback.
const PEAK_LABEL: Expression = [
  "case",
  ["has", "ele"],
  ["concat", ["get", "name"], "\n", ["number-format", ["get", "ele"], {}], " m"],
  ["get", "name"],
]

const labelPaint = {
  "text-color": LABEL_COLOR,
  "text-halo-color": "#ffffff",
  "text-halo-width": 1.2,
}

const hikingPoiLayers = (): LayerSpecification[] =>
  [
    {
      id: "hiking_poi",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "poi",
      minzoom: HIKING_POI_MIN_ZOOM,
      filter: ["all", IS_POINT, HIKING_POI],
      layout: {
        "icon-image": ["get", "class"],
        "icon-size": 1,
        // A guidepost with no name is still worth a pin, so the label is
        // optional rather than the reason the icon appears.
        "text-optional": true,
        "text-field": ["coalesce", ["get", "name_en"], ["get", "name"], ""],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
        "text-anchor": "top",
        "text-offset": [0, 0.8],
        "text-max-width": 9,
      },
      paint: labelPaint,
    },
    {
      id: "mountain_peak_point",
      type: "symbol",
      source: "openmaptiles",
      // Nothing in the base style references this source-layer at all, so
      // peaks and passes simply weren't drawn before.
      "source-layer": "mountain_peak",
      minzoom: PEAK_MIN_ZOOM,
      filter: ["all", IS_POINT, ["==", ["get", "class"], "peak"]],
      layout: {
        "icon-image": "mountain",
        "icon-size": 0.9,
        "text-optional": true,
        "text-field": PEAK_LABEL,
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
        "text-anchor": "top",
        "text-offset": [0, 0.7],
        // The tiles rank peaks by prominence; when two labels collide the
        // more prominent summit should be the one that survives.
        "symbol-sort-key": ["to-number", ["get", "rank"], 99],
      },
      paint: labelPaint,
    },
    {
      id: "mountain_saddle_point",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "mountain_peak",
      // A pass is a landmark and a decision point on foot, but the sprite
      // has no icon for one - so it's a label only, and only once close
      // enough that it isn't competing with the summits around it.
      minzoom: PEAK_MIN_ZOOM + 2,
      filter: ["all", IS_POINT, ["==", ["get", "class"], "saddle"]],
      layout: {
        "text-field": PEAK_LABEL,
        "text-font": ["Noto Sans Italic"],
        "text-size": 10,
        "text-max-width": 9,
        "symbol-sort-key": ["to-number", ["get", "rank"], 99],
      },
      paint: labelPaint,
    },
  ] as unknown as LayerSpecification[]

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
    "line-color": ["case", IS_PAVED, PAVED_TRACK, TRACK],
    "line-width": TRACK_WIDTH,
    "line-dasharray": ["case", IS_PAVED, ["literal", [4, 1]], ["literal", [2, 1.5]]],
  }),
  setPaint("road_track_casing", {
    "line-color": ["case", IS_PAVED, PAVED_TRACK, TRACK],
    "line-width": TRACK_CASING_WIDTH,
    "line-opacity": 0.25,
  }),
  setLayerProps("road_track", { minzoom: PATH_MIN_ZOOM }),
  setLayerProps("road_track_casing", { minzoom: PATH_MIN_ZOOM }),

  // Contours sit under everything else on the map, so the route line, the
  // trails and the markers all stay legible over them.
  addSource(CONTOUR_SOURCE_ID, contourSource()),
  insertLayersBefore("tunnel_motorway_casing", ...contourLayers()),

  // Above the base's own landcover fills, so these refine them rather than
  // being hidden under them, and still below every road and path.
  insertLayersAfter("landcover_wetland", ...terrainLayers()),

  // Forest keeps the base's own layer - it already filters class=wood - but
  // in a green that separates it from open ground rather than blending in.
  // Its canopy texture is added by the pattern overlay.
  setPaint("landcover_wood", { "fill-color": tailwindHex(colors.green[200]), "fill-opacity": 0.55 }),

  // Names belong to the walking network here, not to the road network. The
  // base labels every road class, which on a hiking map is a screen of
  // street names over ways a walker is being steered away from - and it
  // crowds out the one name that matters, the path's. Paths keep their
  // labels, tracks keep theirs (a forest road's name is how it's signed on
  // the ground), and the road classes lose them.
  removeLayer("highway-name-major"),
  setLayerProps("highway-name-minor", {
    filter: [
      "all",
      ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
      ["==", ["get", "class"], "track"],
    ],
  }),

  // Straight after the basemap's own (invisible) POI layers, so these sit
  // with the other point symbols but still below place names.
  insertLayersAfter("poi_r1", ...hikingPoiLayers()),
]
