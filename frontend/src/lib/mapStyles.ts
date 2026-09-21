import { Bike, type LucideIcon } from "lucide-react"

export interface RoadLegendCategory {
  label: string
  // Real layer id in the style JSON providing the fill (top) line - the
  // legend evaluates this layer's actual paint expressions at render time
  // (see lib/mapStyleLegend.ts) instead of hand-copying its color/width, so
  // it can't silently drift out of sync with the style file the way a
  // literal-value mirror can.
  fillLayerId: string
  // Real layer id providing the casing (outline) line underneath the fill,
  // if this category has one (not every category does - e.g. cycleway and
  // footpath render as a single flat line in road-cycling.json).
  casingLayerId?: string
  // Synthetic feature properties to evaluate this category's paint
  // expressions against. Omit for the category's normal/default appearance;
  // set e.g. {surface: "gravel"} to render the "restricted/unsuitable"
  // branch of a layer's case expression.
  properties?: Record<string, unknown>
}

export type RoutingOptionValue = boolean | number
export type RoutingOptions = Record<string, RoutingOptionValue>

// One BRouter profile parameter a visitor can change while planning. Must
// match routing.py's PROFILE_OPTIONS for the style's routingProfile - same
// key, kind, default and (for a choice) values; the backend rejects anything
// else with a 400.
export type RoutingOptionSpec =
  | { key: string; kind: "toggle"; label: string; default: boolean }
  | {
      key: string
      kind: "choice"
      label: string
      default: number
      choices: { value: number; label: string }[]
    }

export interface MapStyleConfig {
  key: string
  label: string
  // Shown next to the label in MapStyleSelect - one per activity, since
  // this registry doubles as the activity list.
  icon: LucideIcon
  styleUrl: string
  // BRouter profile the route planner routes with while this style is
  // active. Deliberately lives here rather than behind its own selector:
  // this registry is already an activity list (see the commented-out gravel/
  // MTB/hiking entries below), so enabling one of those brings its routing
  // along in the same entry. Must be a member of routing.py's
  // ALLOWED_PROFILES, which the backend checks before forwarding.
  routingProfile: string
  // The routingProfile's options shown in the planner panel.
  routingOptions: RoutingOptionSpec[]
  // Road-color legend rows for this style. Omit to hide the "Road colors"
  // section for this style entirely - there's no separate boolean flag to
  // keep in sync with this.
  roadLegend?: RoadLegendCategory[]
}

// Hand-mirrors road-cycling.json's layer ids (not its colors - see
// RoadLegendCategory above) so the legend's road-color rows always reflect
// whatever road-cycling.json currently renders. The last row surfaces the
// style's unified "not suitable for road cycling" look (bike-prohibited OR
// bad surface, see road-cycling.json's UNSUITABLE_* case expressions) via
// road_secondary_tertiary specifically, since its case branches on color
// (motorway's only branches on opacity, which reads poorly as a tiny swatch).
// fastbike-lowtraffic's options (see routing.py's PROFILE_OPTIONS for what
// each does to BRouter's cost model). Ferries and steps default off - unlike
// the profile's own defaults - since a road bike planner shouldn't route onto
// either unless asked.
const FASTBIKE_LOWTRAFFIC_OPTIONS: RoutingOptionSpec[] = [
  {
    key: "consider_traffic",
    kind: "choice",
    label: "How much longer are you willing to ride to avoid traffic?",
    default: 1,
    choices: [
      { value: 0, label: "Not at all" },
      { value: 0.1, label: "A little" },
      { value: 0.3, label: "Somewhat" },
      { value: 0.5, label: "Quite a bit" },
      { value: 1, label: "As much as it takes" },
    ],
  },
  { key: "allow_ferries", kind: "toggle", label: "Allow ferries", default: false },
  { key: "allow_steps", kind: "toggle", label: "Allow steps", default: false },
  { key: "consider_noise", kind: "toggle", label: "Prefer quiet roads", default: false },
  { key: "consider_river", kind: "toggle", label: "Prefer rivers & lakes", default: false },
  { key: "consider_forest", kind: "toggle", label: "Prefer forests & parks", default: false },
  { key: "consider_town", kind: "toggle", label: "Bypass towns", default: false },
]

const ROAD_CYCLING_LEGEND: RoadLegendCategory[] = [
  { label: "Motorway", fillLayerId: "road_motorway", casingLayerId: "road_motorway_casing" },
  { label: "Primary / trunk road", fillLayerId: "road_trunk_primary", casingLayerId: "road_trunk_primary_casing" },
  {
    label: "Secondary / tertiary road",
    fillLayerId: "road_secondary_tertiary",
    casingLayerId: "road_secondary_tertiary_casing",
  },
  { label: "Minor / residential street", fillLayerId: "road_minor", casingLayerId: "road_minor_casing" },
  { label: "Dedicated cycleway", fillLayerId: "cycleway" },
  { label: "Unpaved track", fillLayerId: "road_track", casingLayerId: "road_track_casing" },
  { label: "Footpath", fillLayerId: "road_path_pedestrian" },
  {
    label: "Not suitable for cycling",
    fillLayerId: "road_secondary_tertiary",
    casingLayerId: "road_secondary_tertiary_casing",
    properties: { surface: "gravel" },
  },
]

// OpenFreeMap (openfreemap.org) only ships 4 generic base styles today -
// no activity-specific cartography exists yet, apart from road_cycling
// below. The rest are provisional placeholders; swap styleUrl for a
// self-hosted, custom-authored style per activity later without touching
// any callers of this file.
//
// road_cycling's style.json (public/map-styles/road-cycling.json) is
// OpenFreeMap's "liberty" style, forked and hand-edited: it still points at
// OpenFreeMap's hosted vector tiles/sprite/glyphs (self-hosting those is a
// much bigger undertaking than editing the style layer definitions), but
// adds "cycleway"/"tunnel_cycleway"/"bridge_cycleway" layers that highlight
// class=path/subclass=cycleway ways (OpenMapTiles' tagging for OSM
// highway=cycleway) in blue at every zoom - road cyclists need to spot
// dedicated cycling infrastructure while still planning a route, not just
// once they've zoomed to street level. Any other road/path (motorway down
// to footpath/track) that's bike-prohibited (bicycle=no, or access=no
// without a permissive bicycle override) or tagged with a non-paved surface
// (gravel/dirt/unpaved/etc.) renders grayed-out/dimmed instead of its
// normal class color, so unsuitable roads visually recede.
export const MAP_STYLES: MapStyleConfig[] = [
  {
    key: "road_cycling",
    label: "Road Cycling",
    icon: Bike,
    styleUrl: "/map-styles/road-cycling.json",
    // Road-bike oriented (prefers paved, avoids tracks) while explicitly
    // penalizing high-traffic roads - the same judgement road-cycling.json
    // makes visually by dimming unpaved and bike-prohibited ways.
    routingProfile: "fastbike-lowtraffic",
    routingOptions: FASTBIKE_LOWTRAFFIC_OPTIONS,
    roadLegend: ROAD_CYCLING_LEGEND,
  },
  // { key: "gravel", label: "Gravel", styleUrl: "https://tiles.openfreemap.org/styles/bright" },
  // { key: "mtb", label: "Mountain Biking", styleUrl: "https://tiles.openfreemap.org/styles/bright" },
  // { key: "cycloturism", label: "Cycloturism", styleUrl: "https://tiles.openfreemap.org/styles/liberty" },
  // { key: "hiking", label: "Hiking", styleUrl: "https://tiles.openfreemap.org/styles/positron" },
  // { key: "multiday", label: "Multi-day (Pedestrian)", styleUrl: "https://tiles.openfreemap.org/styles/positron" },
]

export const DEFAULT_MAP_STYLE_KEY = "road_cycling"

export function routingProfileForStyle(key: string): string {
  return (MAP_STYLES.find((s) => s.key === key) ?? MAP_STYLES[0]).routingProfile
}

export function routingOptionSpecsForStyle(key: string): RoutingOptionSpec[] {
  return (MAP_STYLES.find((s) => s.key === key) ?? MAP_STYLES[0]).routingOptions
}

export function defaultRoutingOptions(specs: RoutingOptionSpec[]): RoutingOptions {
  return Object.fromEntries(specs.map((spec) => [spec.key, spec.default]))
}
