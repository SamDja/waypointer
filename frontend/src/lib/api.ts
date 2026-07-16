import type { Candidate, FindPoisResponse, PoiSearchConfig } from "@/types/candidate"

export class ApiError extends Error {}

async function errorDetail(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => null)
  return data && typeof data.detail === "string" ? data.detail : fallback
}

export async function findPois(gpxFile: File, poiConfig: PoiSearchConfig[]): Promise<FindPoisResponse> {
  const formData = new FormData()
  formData.append("gpx_file", gpxFile)
  formData.append("poi_config", JSON.stringify(poiConfig))

  const response = await fetch("/api/find-pois", { method: "POST", body: formData })
  if (!response.ok) {
    throw new ApiError(await errorDetail(response, "Request failed."))
  }
  return (await response.json()) as FindPoisResponse
}

export interface SaveParams {
  gpxFile: File
  selectedCandidates: Candidate[]
  device: string
  waterSymbol: string
  discardedWaypointIndices: number[]
}

export interface SaveResult {
  blob: Blob
  filename: string
}

export async function saveRoute({
  gpxFile,
  selectedCandidates,
  device,
  waterSymbol,
  discardedWaypointIndices,
}: SaveParams): Promise<SaveResult> {
  const formData = new FormData()
  formData.append("gpx_file", gpxFile)
  formData.append("selected_candidates", JSON.stringify(selectedCandidates))
  formData.append("device", device)
  formData.append("water_symbol", waterSymbol)
  formData.append("discarded_waypoint_indices", JSON.stringify(discardedWaypointIndices))

  const response = await fetch("/api/save", { method: "POST", body: formData })
  if (!response.ok) {
    throw new ApiError(await errorDetail(response, "Failed to save."))
  }

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

  const response = await fetch("/api/wahoo/import-route", { method: "POST", body: formData })
  if (!response.ok) {
    throw new ApiError(await errorDetail(response, "Failed to import the Wahoo route."))
  }

  const disposition = response.headers.get("Content-Disposition") ?? ""
  const match = disposition.match(/filename="([^"]+)"/)
  const filename = match ? match[1] : "wahoo_route.gpx"
  const blob = await response.blob()
  return { blob, filename }
}

export interface WahooRoutePayloadResult {
  fitBase64: string
  filename: string
  distanceM: number
  ascentM: number
  startLat: number
  startLng: number
}

export async function fetchWahooRoutePayload(
  gpxFile: File,
  selectedCandidates: Candidate[],
): Promise<WahooRoutePayloadResult> {
  const formData = new FormData()
  formData.append("gpx_file", gpxFile)
  formData.append("selected_candidates", JSON.stringify(selectedCandidates))

  const response = await fetch("/api/wahoo/route-payload", { method: "POST", body: formData })
  if (!response.ok) {
    throw new ApiError(await errorDetail(response, "Failed to build the Wahoo route."))
  }
  const data = await response.json()
  return {
    fitBase64: data.fit_base64,
    filename: data.filename,
    distanceM: data.distance_m,
    ascentM: data.ascent_m,
    startLat: data.start_lat,
    startLng: data.start_lng,
  }
}
