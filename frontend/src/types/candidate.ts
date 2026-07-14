export interface Candidate {
  osm_id: number
  name: string | null
  lat: number
  lon: number
  distance_m: number
}

export interface FindFountainsResponse {
  candidates: Candidate[]
  point_count: number
  existing_waypoint_count: number
  route_coords: [number, number][]
}
