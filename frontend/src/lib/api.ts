import type {
  Candidate,
  FindPoisResponse,
  PoiLookupResult,
  PoiSearchConfig,
  PlaceResult,
  RouteLegResponse,
  SearchRange,
} from "@/types/candidate"

// `message` is always something to show the visitor as-is - raw HTTP
// statuses and server internals never reach it (see request() below).
export class ApiError extends Error {
  status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export const NETWORK_ERROR_MESSAGE = "Couldn't reach the server - check your connection and try again."

// How long to pause an endpoint after a 429 that carries no Retry-After -
// the cool-down the OSM wiki recommends for its public services.
const DEFAULT_COOLDOWN_S = 30

// When each endpoint may be called again after a 429, keyed on its URL
// without the query string. Every call in between fails straight away with
// the same wait message instead of reaching the server: a throttled Find
// POIs fans out into one request per type, and a throttled planner has one
// pending request per leg, and hammering on would only extend the wait.
const cooldownUntil = new Map<string, number>()

function rateLimitMessage(waitS: number): string {
  return `Too many requests - please wait ${waitS} second${waitS === 1 ? "" : "s"} and try again.`
}

function rateLimitError(retryAt: number): ApiError {
  return new ApiError(rateLimitMessage(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))), 429)
}

/** Milliseconds until `url`'s endpoint can be called again, or 0 if it can now. */
export function cooldownRemainingMs(url: string): number {
  return Math.max(0, (cooldownUntil.get(url.split("?")[0]) ?? 0) - Date.now())
}

export interface RequestMessages {
  // Shown when the server (or a service behind it) fails: any 5xx, or a
  // 4xx whose detail isn't meant for the visitor.
  failed: string
  // Shown for a 401 - only Wahoo's API sends them.
  unauthorized?: string
}

interface RequestOptions extends RequestMessages {
  // Our own backend writes each 4xx `detail` for the visitor to read (bad
  // file, no match found...). Third-party APIs don't, so for those it's
  // ignored in favour of `failed`.
  trustDetail?: boolean
}

/**
 * fetch() that throws an ApiError with a readable message for every failure
 * (unreachable server, throttling, server errors), and honours a 429's
 * Retry-After by pausing that endpoint. An abort is rethrown untouched, so
 * callers can still tell a cancelled request from a failed one.
 */
export async function request(
  url: string,
  init: RequestInit,
  { failed, unauthorized, trustDetail = true }: RequestOptions,
): Promise<Response> {
  const key = url.split("?")[0]
  const retryAt = cooldownUntil.get(key)
  if (retryAt !== undefined && retryAt > Date.now()) throw rateLimitError(retryAt)

  let response: Response
  try {
    response = await fetch(url, init)
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err
    throw new ApiError(NETWORK_ERROR_MESSAGE)
  }
  if (response.ok) return response

  if (response.status === 429) {
    const header = Number(response.headers.get("Retry-After"))
    const waitS = Number.isFinite(header) && header > 0 ? header : DEFAULT_COOLDOWN_S
    const until = Date.now() + waitS * 1000
    cooldownUntil.set(key, until)
    throw rateLimitError(until)
  }
  if (response.status === 401 && unauthorized) throw new ApiError(unauthorized, 401)

  const data = await response.json().catch(() => null)
  const detail = data && typeof data.detail === "string" ? data.detail : null
  if (detail) console.warn(`${key} failed (${response.status}): ${detail}`)
  const readable = trustDetail && response.status < 500 && detail !== null
  throw new ApiError(readable ? detail : failed, response.status)
}

export async function findPois(
  gpxFile: File,
  poiConfig: PoiSearchConfig[],
  // Narrows only which stretch of the route the PostGIS query covers - the
  // route planner passes the newly extended span so a re-search after an
  // edit only returns POIs along it. Every distance in the response is
  // still measured against the full route (see schemas.SearchRange).
  searchRange?: SearchRange,
): Promise<FindPoisResponse> {
  const formData = new FormData()
  formData.append("gpx_file", gpxFile)
  formData.append("poi_config", JSON.stringify(poiConfig))
  if (searchRange) formData.append("search_range", JSON.stringify(searchRange))

  const response = await request(
    "/api/find-pois/route",
    { method: "POST", body: formData },
    { failed: "The points-of-interest search isn't working right now - please try again in a moment." },
  )
  return (await response.json()) as FindPoisResponse
}

/**
 * Places matching a typed name, biased towards `near` (the map's centre).
 * Pass `signal` to cancel a search the visitor has already typed past.
 */
export async function searchPlaces(
  query: string,
  near: [number, number] | null,
  signal?: AbortSignal,
): Promise<PlaceResult[]> {
  const params = new URLSearchParams({ q: query })
  if (near) {
    params.set("lat", String(near[0]))
    params.set("lon", String(near[1]))
  }
  const response = await request(
    `/api/geocode?${params}`,
    { signal },
    { failed: "Place search isn't working right now - please try again in a moment." },
  )
  return (await response.json()) as PlaceResult[]
}

export async function routeLeg(
  start: [number, number],
  end: [number, number],
  profile: string,
  options: Record<string, boolean | number>,
): Promise<RouteLegResponse> {
  const formData = new FormData()
  formData.append("start_lat", String(start[0]))
  formData.append("start_lon", String(start[1]))
  formData.append("end_lat", String(end[0]))
  formData.append("end_lon", String(end[1]))
  formData.append("profile", profile)
  formData.append("options", JSON.stringify(options))

  const response = await request(
    "/api/route-leg",
    { method: "POST", body: formData },
    { failed: "Couldn't plan that stretch of route - try again, or move the point onto a nearby road." },
  )
  return (await response.json()) as RouteLegResponse
}

export async function lookupPoi(
  lat: number,
  lon: number,
  poiType: string,
): Promise<PoiLookupResult> {
  const formData = new FormData()
  formData.append("lat", String(lat))
  formData.append("lon", String(lon))
  formData.append("poi_type", poiType)

  const response = await request(
    "/api/find-pois/location",
    { method: "POST", body: formData },
    { failed: "Couldn't look up that point of interest - please try again in a moment." },
  )
  return (await response.json()) as PoiLookupResult
}

export interface SaveParams {
  gpxFile: File
  selectedCandidates: Candidate[]
  device: string
  symbols: Record<string, string>
  discardedWaypointIndices: number[]
  existingWaypointTypes: Record<number, string>
  routeName?: string
}

export interface SaveResult {
  blob: Blob
  filename: string
}

export async function saveRoute({
  gpxFile,
  selectedCandidates,
  device,
  symbols,
  discardedWaypointIndices,
  existingWaypointTypes,
  routeName,
}: SaveParams): Promise<SaveResult> {
  const formData = new FormData()
  formData.append("gpx_file", gpxFile)
  formData.append("selected_candidates", JSON.stringify(selectedCandidates))
  formData.append("device", device)
  formData.append("symbols", JSON.stringify(symbols))
  formData.append("discarded_waypoint_indices", JSON.stringify(discardedWaypointIndices))
  formData.append("existing_waypoint_types", JSON.stringify(existingWaypointTypes))
  if (routeName) formData.append("route_name", routeName)

  const response = await request(
    "/api/save",
    { method: "POST", body: formData },
    { failed: "Couldn't create the route file - please try again in a moment." },
  )

  const disposition = response.headers.get("Content-Disposition") ?? ""
  const match = disposition.match(/filename="([^"]+)"/)
  const filename = match ? match[1] : "route_waypoints.gpx"
  const blob = await response.blob()
  return { blob, filename }
}

export interface ImportedRoute {
  blob: Blob
  filename: string
}

export async function importWahooRoute(fileUrl: string): Promise<ImportedRoute> {
  const formData = new FormData()
  formData.append("file_url", fileUrl)

  const response = await request(
    "/api/wahoo/import-route",
    { method: "POST", body: formData },
    { failed: "Couldn't download that route from Wahoo - please try again in a moment." },
  )

  const disposition = response.headers.get("Content-Disposition") ?? ""
  const match = disposition.match(/filename="([^"]+)"/)
  const filename = match ? match[1] : "wahoo_route.gpx"
  const blob = await response.blob()
  return { blob, filename }
}

export interface WahooRoutePayloadResult {
  fitBase64: string
  filename: string
  routeName: string
  distanceM: number
  ascentM: number
  startLat: number
  startLng: number
}

export async function fetchWahooRoutePayload(
  gpxFile: File,
  selectedCandidates: Candidate[],
  discardedWaypointIndices: number[],
  existingWaypointTypes: Record<number, string>,
  routeName?: string,
): Promise<WahooRoutePayloadResult> {
  const formData = new FormData()
  formData.append("gpx_file", gpxFile)
  formData.append("selected_candidates", JSON.stringify(selectedCandidates))
  formData.append("discarded_waypoint_indices", JSON.stringify(discardedWaypointIndices))
  formData.append("existing_waypoint_types", JSON.stringify(existingWaypointTypes))
  if (routeName) formData.append("route_name", routeName)

  const response = await request(
    "/api/wahoo/route-payload",
    { method: "POST", body: formData },
    { failed: "Couldn't prepare the route for Wahoo - please try again in a moment." },
  )
  const data = await response.json()
  return {
    fitBase64: data.fit_base64,
    filename: data.filename,
    routeName: data.route_name,
    distanceM: data.distance_m,
    ascentM: data.ascent_m,
    startLat: data.start_lat,
    startLng: data.start_lng,
  }
}
