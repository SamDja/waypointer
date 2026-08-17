export interface MapStyleConfig {
  key: string
  label: string
  styleUrl: string
  // Whether MapLegend should render the road-color section (see
  // ROAD_CYCLING_LEGEND below) for this style. There's no way to introspect
  // a MapLibre style JSON's semantics at runtime, so this is a manual flag
  // rather than something derived from styleUrl.
  hasCustomRoadColors?: boolean
}

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
// adds a "cycleway" layer that highlights class=path/subclass=cycleway
// ways (OpenMapTiles' tagging for OSM highway=cycleway) in blue from
// zoom 10, well below the stock style's path/pedestrian layer's minzoom 14 -
// road cyclists need to spot dedicated cycling infrastructure while still
// planning a route, not just once they've zoomed to street level. Road/path
// colors also approximate CyclOSM's (cyclosm.org) palette pulled from its
// CartoCSS source - faded grey motorways, khaki/olive primary-tertiary
// roads, dark-green dashed unpaved tracks (split out of the stock style's
// combined service+track layer into its own road_track/road_track_casing),
// and brown dashed footpaths distinct from the blue cycleway. CyclOSM's
// hillshading/contours and numbered cycle-route ribbons aren't reproduced -
// that data isn't in OpenFreeMap's OpenMapTiles-schema vector tiles. Beyond
// class=motorway, any other road (trunk/primary/secondary/tertiary/minor/
// link/service/track) also renders motorway-grey if OpenFreeMap's transportation
// layer marks it bicycle=no, or access=no without a permissive bicycle
// override - confirmed these fields are actually populated in OpenFreeMap's
// served tiles, not just documented in the abstract OpenMapTiles schema.
// access=private/customers roads are deliberately left at their normal
// class color (a property-access restriction, not a cycling ban).
// Hand-mirrors the line-color/line-dasharray values actually set in
// public/map-styles/road-cycling.json - same "keep two files in sync by
// hand" convention as schemas.py/candidate.ts, since a MapLibre style JSON
// isn't introspectable for "what does this color mean" at runtime.
export const ROAD_CYCLING_LEGEND: { label: string; color: string; dashed?: boolean }[] = [
  { label: "Motorway", color: "#a3a3a3" },
  { label: "Bikes not permitted", color: "#a3a3a3" },
  { label: "Primary / trunk road", color: "#d8b267" },
  { label: "Secondary / tertiary road", color: "#b1bb5d" },
  { label: "Minor / residential street", color: "#888888" },
  { label: "Unpaved track", color: "#5c8a52", dashed: true },
  { label: "Footpath", color: "#8b6b47", dashed: true },
  { label: "Dedicated cycleway", color: "#0033cc" },
]

export const MAP_STYLES: MapStyleConfig[] = [
  {
    key: "road_cycling",
    label: "Road Cycling",
    styleUrl: "/map-styles/road-cycling.json",
    hasCustomRoadColors: true,
  },
  // { key: "gravel", label: "Gravel", styleUrl: "https://tiles.openfreemap.org/styles/bright" },
  // { key: "mtb", label: "Mountain Biking", styleUrl: "https://tiles.openfreemap.org/styles/bright" },
  // { key: "cycloturism", label: "Cycloturism", styleUrl: "https://tiles.openfreemap.org/styles/liberty" },
  // { key: "hiking", label: "Hiking", styleUrl: "https://tiles.openfreemap.org/styles/positron" },
  // { key: "multiday", label: "Multi-day (Pedestrian)", styleUrl: "https://tiles.openfreemap.org/styles/positron" },
]

export const DEFAULT_MAP_STYLE_KEY = "road_cycling"
