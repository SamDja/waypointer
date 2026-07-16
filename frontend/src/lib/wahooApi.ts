// Push to Wahoo's actual resource API (POST /v1/routes), separate from the
// OAuth plumbing in wahooAuth.ts. Confirmed by CORS testing against
// api.wahooligan.com to work directly from the browser (Access-Control-
// Allow-Origin: * on both /oauth/token and /v1/routes) - no backend relay
// needed.
import { ApiError } from "@/lib/api"
import { WAHOO_OAUTH_BASE } from "@/lib/wahooConfig"

// Wahoo's workout_type_family_id taxonomy (confirmed via developer docs):
// 0 = BIKING. This app only ever produces cycling routes.
const WORKOUT_TYPE_FAMILY_ID_BIKING = 0

export interface WahooRoutePayload {
  fitBase64: string
  filename: string
  routeName: string
  distanceM: number
  ascentM: number
  startLat: number
  startLng: number
}

export interface WahooRoute {
  id: number
  name: string
  distanceM: number
  ascentM: number
  createdAt: string
  fileUrl: string
}

interface RawWahooRoute {
  id: number
  name: string
  distance: number
  ascent: number
  created_at: string
  file: { url: string }
}

export async function pushRouteToWahoo(payload: WahooRoutePayload, accessToken: string): Promise<void> {
  const formData = new FormData()
  // Wahoo's docs require route[file] as a data URI, not a bare base64
  // string - without this prefix Wahoo still creates the route record (from
  // the metadata fields below) but can't parse the file itself, so the
  // route never gets a thumbnail/preview/elevation and won't load.
  formData.append("route[file]", `data:application/vnd.fit;base64,${payload.fitBase64}`)
  formData.append("route[filename]", payload.filename)
  // Each push creates a new Wahoo route rather than updating a prior one -
  // there's no server-side state to track a previous push's identity
  // against (this app is stateless end to end).
  formData.append("route[external_id]", crypto.randomUUID())
  formData.append("route[provider_updated_at]", new Date().toISOString())
  formData.append("route[name]", payload.routeName)
  formData.append("route[workout_type_family_id]", String(WORKOUT_TYPE_FAMILY_ID_BIKING))
  formData.append("route[start_lat]", String(payload.startLat))
  formData.append("route[start_lng]", String(payload.startLng))
  formData.append("route[distance]", String(payload.distanceM))
  formData.append("route[ascent]", String(payload.ascentM))

  const response = await fetch(`${WAHOO_OAUTH_BASE}/v1/routes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: formData,
  })
  if (!response.ok) {
    throw new ApiError(`Wahoo rejected the route (${response.status}).`)
  }
}

// Wahoo caps unrevoked access tokens per app+user - disconnecting must
// actually revoke server-side (not just forget the token locally), or
// repeated connect/disconnect cycles (e.g. during dev testing) exhaust the
// cap and every future token exchange starts failing with "Too many
// unrevoked access tokens exist for this app and user."
export async function revokeWahooAccess(accessToken: string): Promise<void> {
  const response = await fetch(`${WAHOO_OAUTH_BASE}/v1/permissions`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new ApiError(`Failed to revoke Wahoo access (${response.status}).`)
  }
}

interface RawWahooUser {
  first: string
  last: string
}

// Requires the "user_read" scope. Wahoo's /v1/user has no profile-picture
// field at all (checked their docs) - only first/last name is available.
export async function getWahooUser(accessToken: string): Promise<{ firstName: string; lastName: string }> {
  const response = await fetch(`${WAHOO_OAUTH_BASE}/v1/user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new ApiError(`Failed to load Wahoo user (${response.status}).`)
  }
  const data = (await response.json()) as RawWahooUser
  return { firstName: data.first, lastName: data.last }
}

export async function listWahooRoutes(accessToken: string): Promise<WahooRoute[]> {
  const response = await fetch(`${WAHOO_OAUTH_BASE}/v1/routes`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new ApiError(`Failed to load Wahoo routes (${response.status}).`)
  }
  const data = (await response.json()) as RawWahooRoute[]
  return data.map((r) => ({
    id: r.id,
    name: r.name,
    distanceM: r.distance,
    ascentM: r.ascent,
    createdAt: r.created_at,
    fileUrl: r.file.url,
  }))
}
