export interface Candidate {
  osm_id: number
  poi_type: string
  name: string | null
  lat: number
  lon: number
  distance_m: number
  distance_from_start_m: number
}

export interface PoiSearchConfig {
  poi_type: string
  max_distance_m: number
}

// Sibling data for a Candidate, keyed by osm_id on
// FindPoisResponse.candidate_details rather than added to Candidate itself -
// Candidate round-trips through /api/save and /api/wahoo/route-payload's
// request bodies, so bloating it with tags would bloat every save/export
// round trip too, not just the search response.
export interface CandidateDetails {
  tags: Record<string, string>
  last_edited: string | null
}

// Resolves a basemap POI icon click to a real OSM node (see
// schemas.py's PoiLookupResult) - carries the full raw tag dict, unlike
// Candidate, so the map popup can show as much OSM info as exists plus an
// edit link.
export interface PoiLookupResult {
  osm_id: number
  osm_type: string
  poi_type: string
  name: string | null
  lat: number
  lon: number
  tags: Record<string, string>
  // ISO 8601 timestamp of this node's last edit on OSM, null if Overpass
  // didn't return one - distinct from a check_date/survey:date tag inside
  // `tags`, which a mapper sets by hand rather than OSM's own edit metadata.
  last_edited: string | null
}

export interface ExistingWaypoint {
  index: number
  name: string | null
  lat: number
  lon: number
  poi_type: string
  distance_from_route_m: number
  distance_from_start_m: number
}

export type HoveredPoi = { kind: "candidate"; id: number } | { kind: "waypoint"; id: number } | null

export interface FailedPoiType {
  poi_type: string
  error: string
}

export interface FindPoisResponse {
  candidates: Candidate[]
  point_count: number
  existing_waypoints: ExistingWaypoint[]
  route_coords: [number, number][]
  failed_poi_types: FailedPoiType[]
  candidate_details: Record<number, CandidateDetails>
}
