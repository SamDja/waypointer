// The visitor's Wahoo routes, through our backend, which uses the Wahoo
// connection stored with the account (connections.py) - the browser never
// talks to Wahoo directly any more, nor holds a Wahoo token.
import { request } from "@/lib/api"
import type { Candidate, WahooRouteResponse } from "@/types/candidate"

// The server refreshes the connection itself, so a 401 means there isn't
// one any more (Wahoo refused it, and the server forgot it).
const UNAUTHORIZED = "Wahoo didn't accept your connection - please connect Wahoo again."

export interface WahooRoute {
  id: number
  name: string
  distanceM: number
  ascentM: number
  createdAt: string
  fileUrl: string
}

export interface WahooPushRequest {
  file: File
  selectedCandidates: Candidate[]
  discardedWaypointIndices: number[]
  existingWaypointTypes: Record<number, string>
  routeName?: string
}

// The server builds the FIT course (only it has the full-resolution,
// elevation-carrying route) and pushes it as a new Wahoo route.
export async function pushRouteToWahoo(push: WahooPushRequest): Promise<void> {
  const form = new FormData()
  form.append("gpx_file", push.file)
  form.append("selected_candidates", JSON.stringify(push.selectedCandidates))
  form.append("discarded_waypoint_indices", JSON.stringify(push.discardedWaypointIndices))
  form.append("existing_waypoint_types", JSON.stringify(push.existingWaypointTypes))
  if (push.routeName) form.append("route_name", push.routeName)
  await request(
    "/api/wahoo/routes",
    { method: "POST", body: form },
    { failed: "Wahoo couldn't save the route - please try again in a moment.", unauthorized: UNAUTHORIZED },
  )
}

export async function listWahooRoutes(): Promise<WahooRoute[]> {
  const response = await request(
    "/api/wahoo/routes",
    {},
    { failed: "Couldn't load your Wahoo routes - please try again in a moment.", unauthorized: UNAUTHORIZED },
  )
  const data = (await response.json()) as WahooRouteResponse[]
  return data.map((r) => ({
    id: r.id,
    name: r.name,
    distanceM: r.distance_m,
    ascentM: r.ascent_m,
    createdAt: r.created_at,
    fileUrl: r.file_url,
  }))
}

export async function deleteWahooRoute(id: number): Promise<void> {
  await request(
    `/api/wahoo/routes/${id}/delete`,
    { method: "POST" },
    { failed: "Wahoo couldn't delete the route - please try again in a moment.", unauthorized: UNAUTHORIZED },
  )
}

// Wahoo's update requires the route's position, distance and ascent too;
// the server re-reads those from Wahoo, so only the name is sent.
export async function renameWahooRoute(id: number, name: string): Promise<void> {
  const form = new FormData()
  form.append("name", name)
  await request(
    `/api/wahoo/routes/${id}/rename`,
    { method: "POST", body: form },
    { failed: "Wahoo couldn't rename the route - please try again in a moment.", unauthorized: UNAUTHORIZED },
  )
}
