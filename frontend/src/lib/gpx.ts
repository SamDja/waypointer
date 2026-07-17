import { projectOntoPolylineM } from "@/lib/geometry"
import { POI_TYPES } from "@/lib/poiTypes"
import type { ExistingWaypoint } from "@/types/candidate"

// Matches the extensions namespace gpx_io.py stamps onto waypoints it adds
// (WAYPOINTER_NS) - a <wpt> carrying a child in this namespace was added by
// a previous Waypointer export. A "poi_type" child carries the exact,
// already-known type (e.g. recovered from a FIT file's course_point_type
// developer field on import - see fit_read.py); an "osm_id" child means the
// waypoint came from a search-candidate add, which only ever means "water"
// today (see gpx_io.infer_poi_type for the same two rules).
const WAYPOINTER_NS = "https://github.com/SamDja/waypointer"

// Mirrors gpx_io.infer_poi_type: poi_type marker first (exact, verbatim),
// then the osm_id marker, then a lowercase substring match of <sym>/<type>
// against each registered type's symHints. Deliberately ignores <name>
// (free text, would false-positive). Always resolves to a concrete
// registry key ("generic" at worst) - this is only a starting suggestion,
// since ImportCard's "Waypoints" tab lets the visitor correct it.
function inferPoiType(wptEl: Element): string {
  const poiTypeMarker = wptEl.getElementsByTagNameNS(WAYPOINTER_NS, "poi_type")[0]?.textContent
  if (poiTypeMarker && POI_TYPES.some((cfg) => cfg.key === poiTypeMarker)) return poiTypeMarker

  if (wptEl.getElementsByTagNameNS(WAYPOINTER_NS, "osm_id").length > 0) return "water"

  const sym = wptEl.getElementsByTagName("sym")[0]?.textContent ?? ""
  const type = wptEl.getElementsByTagName("type")[0]?.textContent ?? ""
  const text = `${sym} ${type}`.toLowerCase()
  for (const cfg of POI_TYPES) {
    if (cfg.symHints.some((hint) => text.includes(hint))) return cfg.key
  }
  return "generic"
}

// Shared by parseRouteCoordsFromGpx and parseExistingWaypointsFromGpx (the
// latter needs the route polyline to project pre-existing waypoints onto).
// Mirrors gpx_io.route_coordinates() in the backend: all track points, then
// all route points.
function extractRouteCoords(doc: Document): [number, number][] {
  const coords: [number, number][] = []
  const pointEls = [...doc.getElementsByTagName("trkpt"), ...doc.getElementsByTagName("rtept")]
  for (const el of pointEls) {
    const lat = parseFloat(el.getAttribute("lat") ?? "")
    const lon = parseFloat(el.getAttribute("lon") ?? "")
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      coords.push([lat, lon])
    }
  }
  return coords
}

// Best-effort client-side parse for an instant map preview right after
// import, before the backend has computed the authoritative route_coords.
// Returns [] on any parse failure - this is not validation, the backend
// still validates the file on "Find Water Fountains".
export function parseRouteCoordsFromGpx(xmlText: string): [number, number][] {
  try {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml")
    if (doc.getElementsByTagName("parsererror").length > 0) return []
    return extractRouteCoords(doc)
  } catch {
    return []
  }
}

// Same trkpt/rtept traversal as parseRouteCoordsFromGpx (index-parallel to
// its result), reading each point's <ele> child instead of lat/lon -
// mirrors the backend's gpx_io.route_elevations(). null where a point has
// no <ele>, matching the backend's None so downstream gain/loss math can
// apply the same skip-gap rule (see lib/geometry.ts's elevationGainLossM).
export function parseRouteElevationsFromGpx(xmlText: string): (number | null)[] {
  try {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml")
    if (doc.getElementsByTagName("parsererror").length > 0) return []

    const elevations: (number | null)[] = []
    const pointEls = [...doc.getElementsByTagName("trkpt"), ...doc.getElementsByTagName("rtept")]
    for (const el of pointEls) {
      const eleText = el.getElementsByTagName("ele")[0]?.textContent
      const ele = eleText ? parseFloat(eleText) : NaN
      elevations.push(Number.isFinite(ele) ? ele : null)
    }
    return elevations
  } catch {
    return []
  }
}

// Best-effort client-side parse of the uploaded file's pre-existing <wpt>
// entries, for instant display before /api/find-pois has run. index is the
// position in document order among top-level <wpt> elements, matching the
// backend's enumerate(gpx.waypoints) in main.py - gpxpy, like this DOM
// walk, only ever treats top-level <wpt> elements as waypoints, so the two
// orderings agree for the same uploaded file. That agreement is what makes
// it safe to send discarded indices computed from this preview straight to
// /api/save without ever having called /api/find-pois.
export function parseExistingWaypointsFromGpx(xmlText: string): ExistingWaypoint[] {
  try {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml")
    if (doc.getElementsByTagName("parsererror").length > 0) return []

    const routeCoords = extractRouteCoords(doc)
    const waypoints: ExistingWaypoint[] = []
    const wptEls = doc.getElementsByTagName("wpt")
    for (let i = 0; i < wptEls.length; i++) {
      const el = wptEls[i]
      const lat = parseFloat(el.getAttribute("lat") ?? "")
      const lon = parseFloat(el.getAttribute("lon") ?? "")
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      const name = el.getElementsByTagName("name")[0]?.textContent ?? null
      const { distanceFromRouteM, distanceFromStartM } = projectOntoPolylineM([lat, lon], routeCoords)
      waypoints.push({
        index: i,
        name,
        lat,
        lon,
        poi_type: inferPoiType(el),
        distance_from_route_m: distanceFromRouteM,
        distance_from_start_m: distanceFromStartM,
      })
    }
    return waypoints
  } catch {
    return []
  }
}
