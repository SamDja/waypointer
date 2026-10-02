// The visitor's Strava routes and activities, through our backend, which
// uses the Strava connection stored with the account (connections.py).
// Strava's API is read-only for routes - there's no create, rename or
// delete - so this is all there is.
import { request } from "@/lib/api"
import type { StravaActivitiesPage, StravaRouteResponse } from "@/types/candidate"

// The server refreshes the connection itself, so a 401 means there isn't
// one any more (Strava refused it, and the server forgot it). The
// backend's message says which; this is the fallback.
const UNAUTHORIZED = "Strava didn't accept your connection - please connect Strava again."

export interface StravaRoute {
  id: string
  name: string
  distanceM: number
  ascentM: number
  createdAt: string
}

export async function listStravaRoutes(): Promise<StravaRoute[]> {
  const response = await request(
    "/api/strava/routes",
    {},
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

export async function importStravaRoute(routeId: string): Promise<Blob> {
  const formData = new FormData()
  formData.append("route_id", routeId)
  const response = await request(
    "/api/strava/import-route",
    { method: "POST", body: formData },
    { failed: "Couldn't download that route from Strava - please try again in a moment.", unauthorized: UNAUTHORIZED },
  )
  return response.blob()
}

export interface StravaActivity {
  id: string
  name: string
  sportType: string
  distanceM: number
  ascentM: number
  startDate: string
}

// One page (1-based) of activities with a GPS track, newest first, and
// whether there may be more - an athlete can have thousands, so they're
// fetched a page at a time. Needs the activity:read_all scope, which
// connections made before activity import don't have (see stravaAuth.ts's
// hasStravaActivityScope).
export async function listStravaActivities(page: number): Promise<{ activities: StravaActivity[]; hasMore: boolean }> {
  const response = await request(
    `/api/strava/activities?page=${page}`,
    {},
    { failed: "Couldn't load your Strava activities - please try again in a moment.", unauthorized: UNAUTHORIZED },
  )
  const data = (await response.json()) as StravaActivitiesPage
  const activities = data.activities.map((a) => ({
    id: a.id,
    name: a.name,
    sportType: a.sport_type,
    distanceM: a.distance_m,
    ascentM: a.ascent_m,
    startDate: a.start_date,
  }))
  return { activities, hasMore: data.has_more }
}

// The activity's track as GPX, built by the backend from its streams.
export async function importStravaActivity(activityId: string, name: string): Promise<Blob> {
  const formData = new FormData()
  formData.append("activity_id", activityId)
  formData.append("name", name)
  const response = await request(
    "/api/strava/import-activity",
    { method: "POST", body: formData },
    {
      failed: "Couldn't download that activity from Strava - please try again in a moment.",
      unauthorized: UNAUTHORIZED,
    },
  )
  return response.blob()
}

// "GravelRide" -> "Gravel ride", for the dialog's label on an activity.
// Strava's e-bike types read badly split mechanically, so they're named.
const SPORT_LABELS: Record<string, string> = {
  EBikeRide: "E-bike ride",
  EMountainBikeRide: "E-MTB ride",
  MountainBikeRide: "MTB ride",
}

export function stravaSportLabel(sportType: string): string {
  if (!sportType) return "Activity"
  if (SPORT_LABELS[sportType]) return SPORT_LABELS[sportType]
  const words = sportType.split(/(?<=[a-z])(?=[A-Z])/)
  return [words[0], ...words.slice(1).map((w) => w.toLowerCase())].join(" ")
}

// A route's own page on strava.com, for the manage dialog (Strava's API
// can't rename or delete, so that's where it's done).
export function stravaRouteUrl(routeId: string): string {
  return `https://www.strava.com/routes/${routeId}`
}
