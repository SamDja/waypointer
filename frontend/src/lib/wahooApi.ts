// Push to Wahoo's actual resource API (POST /v1/routes), separate from the
// OAuth plumbing in wahooAuth.ts. Confirmed by CORS testing against
// api.wahooligan.com to work directly from the browser (Access-Control-
// Allow-Origin: * on both /oauth/token and /v1/routes) - no backend relay
// needed.
import { request } from "@/lib/api"
import { WAHOO_OAUTH_BASE } from "@/lib/wahooConfig"

// Wahoo's workout_type_family_id taxonomy (confirmed via developer docs):
// 0 = BIKING. This app only ever produces cycling routes.
const WORKOUT_TYPE_FAMILY_ID_BIKING = 0

// Every call here already went through getValidWahooAccessToken's refresh,
// so a 401 means Wahoo no longer accepts this connection at all.
const UNAUTHORIZED = "Wahoo didn't accept your connection - disconnect and reconnect Wahoo, then try again."

function wahooMessages(failed: string) {
  return { failed, unauthorized: UNAUTHORIZED, trustDetail: false }
}

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
  startLat: number
  startLng: number
}

interface RawWahooRoute {
  id: number
  name: string
  distance: number
  ascent: number
  created_at: string
  file: { url: string }
  start_lat: number
  start_lng: number
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

  await request(
    `${WAHOO_OAUTH_BASE}/v1/routes`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    },
    wahooMessages("Wahoo couldn't save the route - please try again in a moment."),
  )
}

// Wahoo caps unrevoked access tokens per app+user - disconnecting must
// actually revoke server-side (not just forget the token locally), or
// repeated connect/disconnect cycles (e.g. during dev testing) exhaust the
// cap and every future token exchange starts failing with "Too many
// unrevoked access tokens exist for this app and user."
export async function revokeWahooAccess(accessToken: string): Promise<void> {
  await request(
    `${WAHOO_OAUTH_BASE}/v1/permissions`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    wahooMessages("Couldn't disconnect from Wahoo - please try again in a moment."),
  )
}

interface RawWahooUser {
  first: string
  last: string
}

// Requires the "user_read" scope. Wahoo's /v1/user has no profile-picture
// field at all (checked their docs) - only first/last name is available.
export async function getWahooUser(accessToken: string): Promise<{ firstName: string; lastName: string }> {
  const response = await request(
    `${WAHOO_OAUTH_BASE}/v1/user`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    wahooMessages("Couldn't load your Wahoo profile - please try again in a moment."),
  )
  const data = (await response.json()) as RawWahooUser
  return { firstName: data.first, lastName: data.last }
}

export async function listWahooRoutes(accessToken: string): Promise<WahooRoute[]> {
  const response = await request(
    `${WAHOO_OAUTH_BASE}/v1/routes`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    wahooMessages("Couldn't load your Wahoo routes - please try again in a moment."),
  )
  const data = (await response.json()) as RawWahooRoute[]
  return data.map((r) => ({
    id: r.id,
    name: r.name,
    distanceM: r.distance,
    ascentM: r.ascent,
    createdAt: r.created_at,
    fileUrl: r.file.url,
    startLat: r.start_lat,
    startLng: r.start_lng,
  }))
}

export async function deleteWahooRoute(id: number, accessToken: string): Promise<void> {
  await request(
    `${WAHOO_OAUTH_BASE}/v1/routes/${id}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    wahooMessages("Wahoo couldn't delete the route - please try again in a moment."),
  )
}

// Wahoo's PUT /v1/routes/:id requires route[provider_updated_at],
// route[start_lat], route[start_lng], route[distance], and route[ascent] on
// every update (only file-related fields are optional) - so a name-only
// rename still has to resend the route's existing values for the rest.
export async function updateWahooRouteName(route: WahooRoute, name: string, accessToken: string): Promise<void> {
  const formData = new FormData()
  formData.append("route[name]", name)
  formData.append("route[provider_updated_at]", new Date().toISOString())
  formData.append("route[start_lat]", String(route.startLat))
  formData.append("route[start_lng]", String(route.startLng))
  formData.append("route[distance]", String(route.distanceM))
  formData.append("route[ascent]", String(route.ascentM))

  await request(
    `${WAHOO_OAUTH_BASE}/v1/routes/${route.id}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    },
    wahooMessages("Wahoo couldn't rename the route - please try again in a moment."),
  )
}
