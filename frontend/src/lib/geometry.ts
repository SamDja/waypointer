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
