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

export interface ExistingWaypoint {
  index: number
  name: string | null
  lat: number
  lon: number
  poi_type: string | null
  distance_from_route_m: number
  distance_from_start_m: number
}

export interface FindPoisResponse {
  candidates: Candidate[]
  point_count: number
  existing_waypoints: ExistingWaypoint[]
  route_coords: [number, number][]
}
