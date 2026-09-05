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
}
