// Pure math, no DOM - a JS port of src/waypointer/geometry.py's
// haversine_m/total_distance_m and gpx_io.py's total_ascent_m, so the
// client-side route stats shown right after import (see App.tsx) match the
// backend's own formulas exactly. No backend endpoint returns these values
// today (FindPoisResponse only carries point_count), so this is the sole
// source - not just an instant preview upgraded later.
const EARTH_RADIUS_M = 6_371_000

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = (lat1 * Math.PI) / 180
  const phi2 = (lat2 * Math.PI) / 180
  const dPhi = ((lat2 - lat1) * Math.PI) / 180
  const dLambda = ((lon2 - lon1) * Math.PI) / 180
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a))
}

function toLocalXY(lat: number, lon: number, refLat: number): [number, number] {
  const x = ((lon * Math.PI) / 180) * Math.cos((refLat * Math.PI) / 180) * EARTH_RADIUS_M
  const y = (lat * Math.PI) / 180 * EARTH_RADIUS_M
  return [x, y]
}

// Port of geometry.py's _point_to_segment_projection: distance from p to
// segment a-b, and the fractional position t along a-b (clamped to [0, 1])
// of the closest point - t is what lets projectOntoPolylineM turn a
// perpendicular-distance search into a cumulative distance-from-start.
function pointToSegmentProjection(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): { distanceM: number; t: number } {
  const refLat = (p[0] + a[0] + b[0]) / 3
  const [px, py] = toLocalXY(p[0], p[1], refLat)
  const [ax, ay] = toLocalXY(a[0], a[1], refLat)
  const [bx, by] = toLocalXY(b[0], b[1], refLat)

  const abx = bx - ax
  const aby = by - ay
  const lenSq = abx * abx + aby * aby
  if (lenSq === 0) return { distanceM: Math.hypot(px - ax, py - ay), t: 0 }

  let t = ((px - ax) * abx + (py - ay) * aby) / lenSq
  t = Math.max(0, Math.min(1, t))
  const closestX = ax + t * abx
  const closestY = ay + t * aby
  return { distanceM: Math.hypot(px - closestX, py - closestY), t }
}

export interface PolylineProjection {
  distanceFromRouteM: number
  distanceFromStartM: number
  // Index of the polyline segment (i, i+1) the projection landed on. Has no
  // backend equivalent - it exists so the route planner can tell whether an
  // edit could possibly have changed a cached distance without re-measuring
  // against the whole route (see lib/routePlanner.ts's incremental updates).
  // -1 for a degenerate polyline with fewer than 2 points.
  nearestSegmentIndex: number
}

// Port of geometry.py's project_onto_polyline_m: p's perpendicular distance
// to the nearest segment of polyline, and the cumulative distance along
// polyline from its first point to that nearest projection.
export function projectOntoPolylineM(
  p: [number, number],
  polyline: [number, number][]
): PolylineProjection {
  if (polyline.length === 0) {
    return { distanceFromRouteM: NaN, distanceFromStartM: NaN, nearestSegmentIndex: -1 }
  }
  if (polyline.length === 1) {
    return {
      distanceFromRouteM: haversineM(p[0], p[1], polyline[0][0], polyline[0][1]),
      distanceFromStartM: 0,
      nearestSegmentIndex: -1,
    }
  }

  let bestDistanceM = Infinity
  let bestDistanceFromStartM = 0
  let bestSegmentIndex = 0
  let cumulativeM = 0
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]
    const b = polyline[i + 1]
    const segmentLenM = haversineM(a[0], a[1], b[0], b[1])
    const { distanceM, t } = pointToSegmentProjection(p, a, b)
    if (distanceM < bestDistanceM) {
      bestDistanceM = distanceM
      bestDistanceFromStartM = cumulativeM + t * segmentLenM
      bestSegmentIndex = i
    }
    cumulativeM += segmentLenM
  }
  return {
    distanceFromRouteM: bestDistanceM,
    distanceFromStartM: bestDistanceFromStartM,
    nearestSegmentIndex: bestSegmentIndex,
  }
}

export interface Bbox {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

// Bounding box of coords, grown by padM in every direction. Used as a cheap
// prefilter before the exact distance check - a point outside the padded box
// cannot be within padM of any point inside it. The longitude padding uses
// the box's own latitude for the cos() term, deliberately taking whichever
// bound is closer to the equator so the box is never under-padded.
export function bboxOfCoords(coords: [number, number][], padM: number): Bbox | null {
  if (coords.length === 0) return null
  let minLat = Infinity
  let minLon = Infinity
  let maxLat = -Infinity
  let maxLon = -Infinity
  for (const [lat, lon] of coords) {
    minLat = Math.min(minLat, lat)
    minLon = Math.min(minLon, lon)
    maxLat = Math.max(maxLat, lat)
    maxLon = Math.max(maxLon, lon)
  }
  const latPad = (padM / EARTH_RADIUS_M) * (180 / Math.PI)
  const widestLat = Math.min(Math.abs(minLat), Math.abs(maxLat))
  const cosLat = Math.max(Math.cos((widestLat * Math.PI) / 180), 1e-6)
  const lonPad = latPad / cosLat
  return {
    minLat: minLat - latPad,
    minLon: minLon - lonPad,
    maxLat: maxLat + latPad,
    maxLon: maxLon + lonPad,
  }
}

export function isInBbox([lat, lon]: [number, number], box: Bbox): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon
}

// Shared display formatting for "from track"/"from start" distances in
// CandidateChecklist - meters below 1km, one-decimal km above, mirroring
// ImportCard's existing inline (distanceM / 1000).toFixed(1) km formatting.
export function formatDistanceM(m: number): string {
  if (!Number.isFinite(m)) return "-"
  if (m >= 1000) return `${(m / 1000).toFixed(1)}km`
  return `${m.toFixed(0)}m`
}

export function totalDistanceM(coords: [number, number][]): number {
  let total = 0
  for (let i = 0; i < coords.length - 1; i++) {
    total += haversineM(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
  }
  return total
}

// Elevation changes smaller than this are treated as noise (GPS jitter, DEM
// steps) rather than climbing - see elevationGainLossM.
export const ELEVATION_NOISE_M = 5

/**
 * Total climb and descent, ignoring noise: a change only counts once the
 * elevation has moved at least `noiseM` from the last counted level
 * (hysteresis), so a road wobbling +-2m adds nothing while a steady climb is
 * counted in full. Same skip-gap rule as before: a point without elevation
 * breaks the run instead of being bridged.
 *
 * Deliberately NOT the same as the backend's gpx_io.total_ascent_m and
 * fit_io's FIT ascent fields, which still sum every pairwise delta - the
 * numbers shown in the app can therefore read a little lower than what a
 * Wahoo shows for the same route. Mirroring the filter there is a follow-up,
 * kept separate from FIT changes that need checking on the device.
 */
export function elevationGainLossM(
  elevations: (number | null)[],
  noiseM: number = ELEVATION_NOISE_M
): { gainM: number; lossM: number } {
  let gainM = 0
  let lossM = 0
  let reference: number | null = null
  for (const elevation of elevations) {
    if (elevation === null) {
      reference = null
      continue
    }
    if (reference === null) {
      reference = elevation
      continue
    }
    const delta = elevation - reference
    if (delta >= noiseM) {
      gainM += delta
      reference = elevation
    } else if (delta <= -noiseM) {
      lossM += -delta
      reference = elevation
    }
  }
  return { gainM, lossM }
}

/** Distance from the start to each coordinate, index-aligned with `coords`. */
export function cumulativeDistancesM(coords: [number, number][]): number[] {
  const distances = coords.length > 0 ? [0] : []
  for (let i = 1; i < coords.length; i++) {
    const [a, b] = [coords[i - 1], coords[i]]
    distances.push(distances[i - 1] + haversineM(a[0], a[1], b[0], b[1]))
  }
  return distances
}

/**
 * The point `distanceM` along the route, interpolated between vertices -
 * `cumulative` is cumulativeDistancesM(coords). Clamped to the route's ends.
 */
export function pointAtDistanceM(
  coords: [number, number][],
  cumulative: number[],
  distanceM: number
): [number, number] | null {
  if (coords.length === 0) return null
  if (distanceM <= 0) return coords[0]
  const total = cumulative[cumulative.length - 1]
  if (distanceM >= total) return coords[coords.length - 1]
  // Binary search for the segment containing distanceM.
  let lo = 0
  let hi = cumulative.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cumulative[mid] <= distanceM) lo = mid
    else hi = mid
  }
  const span = cumulative[hi] - cumulative[lo]
  const t = span > 0 ? (distanceM - cumulative[lo]) / span : 0
  return [
    coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t,
    coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t,
  ]
}

export function formatDurationHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "-"
  const totalMinutes = Math.round(hours * 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}
