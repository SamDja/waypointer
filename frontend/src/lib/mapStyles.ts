import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec"
import { Bike, Footprints, type LucideIcon } from "lucide-react"

import { composeStyle } from "./mapStyle/compose"
import { hikingStyle } from "./mapStyle/hiking"
import { houseStyle } from "./mapStyle/houseStyle"
import { roadCyclingStyle } from "./mapStyle/roadCycling"

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

/**
 * What this activity assumes before a visitor tells it otherwise.
 *
 * These live on the activity rather than as module constants because every
 * one of them is wrong for the other activity: 20 km/h is a bike, 4.5 is a
 * walk, and a 500m detour is a couple of minutes on one and the better part
 * of ten on the other. `lib/settings.ts` stores whatever the visitor sets
 * keyed by activity, so tuning one never silently changes the other.
 */
export interface ActivityDefaults {
  avgSpeedKmh: number
  // How far a route edit may strand a checked waypoint before it's flagged
  // for unchecking (see OffRouteDialog).
  offRouteThresholdM: number
  // The POI types a fresh browser starts with for this activity.
  visiblePoiTypes: readonly string[]
}

export interface MapStyleConfig {
  key: string
  label: string
  // Shown next to the label in MapStyleSelect - one per activity, since
  // this registry doubles as the activity list.
  icon: LucideIcon
  // Composes this activity's finished MapLibre style from the vendored base
  // plus the house and activity patches (see lib/mapStyle/compose.ts).
  //
  // A function rather than a value because composing is not free and not
  // always pure: hiking's contour source starts a web worker and registers
  // a maplibre protocol the first time it's built. Read it through
  // mapStyleFor(), which memoises, so only the activity a visitor actually
  // selects pays for itself - and so the map and the legend are handed the
  // identical object and can't drift.
  buildStyle: () => StyleSpecification
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
  defaults: ActivityDefaults
}

// fastbike's options (see routing.py's PROFILE_OPTIONS for what each does to
// BRouter's cost model). Ferries and steps default off - unlike the profile's
// own defaults - since a road bike planner shouldn't route onto either unless
// asked. Traffic defaults to fastbike's own 0.1 ("A little").
const FASTBIKE_OPTIONS: RoutingOptionSpec[] = [
  {
    key: "consider_traffic",
    kind: "choice",
    label: "How much longer are you willing to ride to avoid traffic?",
    default: 0.1,
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

// hiking-mountain's options (see routing.py's PROFILE_OPTIONS for what each
// does to BRouter's cost model, and why this profile rather than the
// hiking-beta the public instance also serves).
//
// Unlike FASTBIKE_OPTIONS, steps and ferries keep the profile's own
// defaults - both are ordinary parts of a walking route rather than things
// to route around.
const HIKING_OPTIONS: RoutingOptionSpec[] = [
  {
    key: "SAC_scale_preferred",
    kind: "choice",
    // The SAC mountaineering scale's own wording, since a walker who cares
    // about the difference already knows these grades, and a walker who
    // doesn't is served by the plain-language half of each label.
    label: "How technical a trail are you happy on?",
    default: 1,
    choices: [
      { value: 1, label: "T1 · Hiking" },
      { value: 2, label: "T2 · Mountain hiking" },
      { value: 3, label: "T3 · Demanding mountain hiking" },
    ],
  },
  {
    key: "hiking_routes_preference",
    kind: "choice",
    label: "How much do you want to stick to marked trails?",
    default: 0.2,
    choices: [
      { value: 0.1, label: "A little" },
      { value: 0.2, label: "Somewhat" },
      { value: 0.5, label: "Quite a bit" },
      { value: 1, label: "As much as possible" },
    ],
  },
  { key: "iswet", kind: "toggle", label: "Avoid mud & wet ground", default: false },
  { key: "consider_elevation", kind: "toggle", label: "Prefer less climbing", default: false },
  { key: "allow_steps", kind: "toggle", label: "Allow steps", default: true },
  { key: "allow_ferries", kind: "toggle", label: "Allow ferries", default: true },
]

// Hand-mirrors road-cycling.json's layer ids (not its colors - see
// RoadLegendCategory above) so the legend's road-color rows always reflect
// whatever road-cycling.json currently renders. The last row surfaces the
// style's unified "not suitable for road cycling" look (bike-prohibited OR
// bad surface, see road-cycling.json's UNSUITABLE_* case expressions) via
// road_secondary_tertiary specifically, since its case branches on color
// (motorway's only branches on opacity, which reads poorly as a tiny swatch).
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

// Hand-mirrors hiking.ts's layer ids, the same way ROAD_CYCLING_LEGEND
// mirrors roadCycling.ts's. The last row shows the style's "you can't walk
// here" look via a minor road with foot=no, rather than a motorway - a
// motorway is always dim in this style, so it wouldn't show that the dimming
// is a judgement about access.
const HIKING_LEGEND: RoadLegendCategory[] = [
  // The style tells the five path subclasses apart by dash pattern, which a
  // swatch this size can't show (and the legend evaluator only reads colour,
  // width and whether a line is dashed at all). So these rows show the
  // distinction it *can* carry - what a way is surfaced with - and leave the
  // dash vocabulary to the map itself.
  { label: "Path or trail", fillLayerId: "road_path_pedestrian" },
  { label: "Paved path or footway", fillLayerId: "road_path_pedestrian", properties: { surface: "paved" } },
  { label: "Unpaved track", fillLayerId: "road_track", casingLayerId: "road_track_casing" },
  {
    label: "Paved track",
    fillLayerId: "road_track",
    casingLayerId: "road_track_casing",
    properties: { surface: "paved" },
  },
  { label: "Contour line", fillLayerId: "contour_line", properties: { level: 1 } },
  { label: "Minor / residential street", fillLayerId: "road_minor", casingLayerId: "road_minor_casing" },
  {
    label: "Secondary / tertiary road",
    fillLayerId: "road_secondary_tertiary",
    casingLayerId: "road_secondary_tertiary_casing",
  },
  { label: "Motorway / trunk road", fillLayerId: "road_trunk_primary", casingLayerId: "road_trunk_primary_casing" },
  {
    label: "Closed to walkers",
    fillLayerId: "road_minor",
    casingLayerId: "road_minor_casing",
    properties: { foot: "no" },
  },
]

// Each activity's cartography is composed from one vendored copy of
// OpenFreeMap's "liberty" style plus two patches - see
// lib/mapStyle/compose.ts for the whole arrangement, houseStyle.ts for the
// shared look, and each activity's own module for its judgement. Tiles,
// sprite and glyphs still come from OpenFreeMap; only the layer definitions
// are ours.
export const MAP_STYLES: MapStyleConfig[] = [
  {
    key: "road_cycling",
    label: "Road Cycling",
    icon: Bike,
    buildStyle: () => composeStyle(...houseStyle, ...roadCyclingStyle()),
    // Road-bike oriented (prefers paved, avoids tracks) - the same judgement
    // roadCycling.ts makes visually by dimming unpaved and bike-prohibited
    // ways. fastbike rather than fastbike-lowtraffic: the two profiles are
    // identical except for consider_traffic's default, and that's an option
    // the visitor sets anyway (see FASTBIKE_OPTIONS).
    routingProfile: "fastbike",
    routingOptions: FASTBIKE_OPTIONS,
    roadLegend: ROAD_CYCLING_LEGEND,
    defaults: {
      avgSpeedKmh: 20,
      offRouteThresholdM: 500,
      // Water is the core case the app was built around; everything else
      // the visitor adds from FindPoisCard's picker.
      visiblePoiTypes: ["water"],
    },
  },
  {
    key: "hiking",
    label: "Hiking",
    icon: Footprints,
    buildStyle: () => composeStyle(...houseStyle, ...hikingStyle()),
    // See routing.py's PROFILE_OPTIONS for why hiking-mountain rather than
    // the hiking-beta the public BRouter instance also serves.
    routingProfile: "hiking-mountain",
    routingOptions: HIKING_OPTIONS,
    roadLegend: HIKING_LEGEND,
    defaults: {
      // A steady walking pace on mixed ground. Ascent is what really sets
      // walking times, which a flat speed can't express - see RouteStats.
      avgSpeedKmh: 4.5,
      // 500m is a couple of minutes on a bike and the better part of ten on
      // foot, which is far too long to be worth not mentioning.
      offRouteThresholdM: 150,
      // Water still, plus the summit a walk is usually aimed at and the
      // huts that make a long one possible.
      visiblePoiTypes: ["water", "summit", "lodging"],
    },
  },
]

export const DEFAULT_MAP_STYLE_KEY = "road_cycling"

// Memoised so repeated renders reuse one style object - MapLibre diffs a
// new style against the old one on every change, and two structurally
// identical but distinct objects would make it redo the whole thing.
const composedStyles = new Map<string, StyleSpecification>()

export function mapStyleFor(key: string): StyleSpecification {
  const config = MAP_STYLES.find((s) => s.key === key) ?? MAP_STYLES[0]
  let style = composedStyles.get(config.key)
  if (!style) {
    style = config.buildStyle()
    composedStyles.set(config.key, style)
  }
  return style
}

/** This activity's assumptions, falling back to the first style's. */
export function activityDefaults(key: string): ActivityDefaults {
  return (MAP_STYLES.find((s) => s.key === key) ?? MAP_STYLES[0]).defaults
}

export function routingProfileForStyle(key: string): string {
  return (MAP_STYLES.find((s) => s.key === key) ?? MAP_STYLES[0]).routingProfile
}

export function routingOptionSpecsForStyle(key: string): RoutingOptionSpec[] {
  return (MAP_STYLES.find((s) => s.key === key) ?? MAP_STYLES[0]).routingOptions
}

export function defaultRoutingOptions(specs: RoutingOptionSpec[]): RoutingOptions {
  return Object.fromEntries(specs.map((spec) => [spec.key, spec.default]))
}
