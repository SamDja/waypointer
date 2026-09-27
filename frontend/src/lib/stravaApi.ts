// The visitor's Strava routes, through our backend's Strava proxy (see
// strava.py for why it's proxied). Strava's API is read-only for routes -
// there's no create, rename or delete - so this is all there is.
import { request } from "@/lib/api"
import type { StravaRouteResponse } from "@/types/candidate"

// Every call here already went through getValidStravaTokens' refresh, so a
// 401 means Strava no longer accepts this connection at all.
const UNAUTHORIZED = "Strava didn't accept your connection - disconnect and reconnect Strava, then try again."

function bearer(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` }
}

export interface StravaRoute {
  id: string
  name: string
  distanceM: number
  ascentM: number
  createdAt: string
}

export async function listStravaRoutes(accessToken: string, athleteId: number): Promise<StravaRoute[]> {
  const params = new URLSearchParams({ athlete_id: String(athleteId) })
  const response = await request(
    `/api/strava/routes?${params.toString()}`,
    { headers: bearer(accessToken) },
    { failed: "Couldn't load your Strava routes - please try again in a moment.", unauthorized: UNAUTHORIZED },
  )
  const data = (await response.json()) as StravaRouteResponse[]
  return data.map((r) => ({
    id: r.id,
    name: r.name,
    distanceM: r.distance_m,
    ascentM: r.ascent_m,
    createdAt: r.created_at,
  }))
}

export async function revokeStravaAccess(accessToken: string): Promise<void> {
  await request(
    "/api/strava/deauthorize",
    { method: "POST", headers: bearer(accessToken) },
    { failed: "Couldn't disconnect from Strava - please try again in a moment.", unauthorized: UNAUTHORIZED },
  )
}

export async function importStravaRoute(routeId: string, accessToken: string): Promise<Blob> {
  const formData = new FormData()
  formData.append("route_id", routeId)
  const response = await request(
    "/api/strava/import-route",
    { method: "POST", headers: bearer(accessToken), body: formData },
    { failed: "Couldn't download that route from Strava - please try again in a moment.", unauthorized: UNAUTHORIZED },
  )
  return response.blob()
}

// A route's own page on strava.com, for the manage dialog (Strava's API
// can't rename or delete, so that's where it's done).
export function stravaRouteUrl(routeId: string): string {
  return `https://www.strava.com/routes/${routeId}`
}
