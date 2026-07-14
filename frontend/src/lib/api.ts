import type { Candidate, FindFountainsResponse } from "@/types/candidate"

export class ApiError extends Error {}

async function errorDetail(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => null)
  return data && typeof data.detail === "string" ? data.detail : fallback
}

export async function findFountains(gpxFile: File): Promise<FindFountainsResponse> {
  const formData = new FormData()
  formData.append("gpx_file", gpxFile)

  const response = await fetch("/api/find-fountains", { method: "POST", body: formData })
  if (!response.ok) {
    throw new ApiError(await errorDetail(response, "Request failed."))
  }
  return (await response.json()) as FindFountainsResponse
}

export interface SaveParams {
  gpxFile: File
  selectedCandidates: Candidate[]
  device: string
  waterSymbol: string
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
}: SaveParams): Promise<SaveResult> {
  const formData = new FormData()
  formData.append("gpx_file", gpxFile)
  formData.append("selected_candidates", JSON.stringify(selectedCandidates))
  formData.append("device", device)
  formData.append("water_symbol", waterSymbol)

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
