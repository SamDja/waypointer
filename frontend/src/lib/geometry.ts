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

// Port of geometry.py's project_onto_polyline_m: p's perpendicular distance
// to the nearest segment of polyline, and the cumulative distance along
// polyline from its first point to that nearest projection.
export function projectOntoPolylineM(
  p: [number, number],
  polyline: [number, number][]
): { distanceFromRouteM: number; distanceFromStartM: number } {
  if (polyline.length === 0) return { distanceFromRouteM: NaN, distanceFromStartM: NaN }
  if (polyline.length === 1) {
    return { distanceFromRouteM: haversineM(p[0], p[1], polyline[0][0], polyline[0][1]), distanceFromStartM: 0 }
  }

  let bestDistanceM = Infinity
  let bestDistanceFromStartM = 0
  let cumulativeM = 0
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]
    const b = polyline[i + 1]
    const segmentLenM = haversineM(a[0], a[1], b[0], b[1])
    const { distanceM, t } = pointToSegmentProjection(p, a, b)
    if (distanceM < bestDistanceM) {
      bestDistanceM = distanceM
      bestDistanceFromStartM = cumulativeM + t * segmentLenM
    }
    cumulativeM += segmentLenM
  }
  return { distanceFromRouteM: bestDistanceM, distanceFromStartM: bestDistanceFromStartM }
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

// Same pairwise skip-gap rule as total_ascent_m: a delta is only counted
// when both points carry elevation - a gap where one side lacks it is
// skipped rather than bridged. Loss mirrors gain with negative deltas.
export function elevationGainLossM(elevations: (number | null)[]): { gainM: number; lossM: number } {
  let gainM = 0
  let lossM = 0
  for (let i = 0; i < elevations.length - 1; i++) {
    const a = elevations[i]
    const b = elevations[i + 1]
    if (a === null || b === null) continue
    const delta = b - a
    if (delta > 0) gainM += delta
    else lossM += -delta
  }
  return { gainM, lossM }
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
