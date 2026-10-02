import { cumulativeDistancesM } from "@/lib/geometry"

// Climb detection, classification and route difficulty. Pure: the elevation
// profile draws the result, and the natural-language route generator will
// rank candidates by it.

// The profile is resampled onto this fixed step before anything else, so
// thresholds below mean the same thing on a dense GPS track and on a sparse
// routed one.
const RESAMPLE_M = 25
// A moving average over this many samples (75m) irons out DEM steps, which
// otherwise read as short walls and break a steady climb into pieces.
const SMOOTH_SAMPLES = 3
// A climb survives a dip below its highest point so far as long as the dip
// is no deeper than this (or DIP_FRACTION of the climb's ascent so far,
// whichever is more, up to DIP_MAX_M)...
const DIP_MIN_M = 10
const DIP_FRACTION = 0.1
const DIP_MAX_M = 40
// ...and the road gets back above that point within this distance. A longer
// flat or descending stretch ends the climb.
const MAX_FLAT_M = 1000
// A climb's ends are trimmed while the stretch at either end is gentler than
// the activity's minimum gradient, so a long false flat before the real climb
// doesn't dilute its average.
const TRIM_WINDOW_M = 300
// The maximum gradient is the steepest average over this distance - the same
// as the elevation profile's smallest colour chunk, so the number matches a
// colour the visitor can see rather than one noisy step.
export const MAX_GRADE_WINDOW_M = 100
// Route difficulty reads steepness over this much longer window: what makes a
// route hard is a sustained gradient, while over 100m a single ramp (a bridge
// approach, a village street) would rate a valley ride like Monte Grappa.
// Mirrored by src/waypointer/climbs.py's DIFFICULTY_GRADE_WINDOW_M.
export const DIFFICULTY_GRADE_WINDOW_M = 1000

// Strava's climb categories by score (length in m x average gradient in %).
export type ClimbCategory = "HC" | 1 | 2 | 3 | 4
const CATEGORY_SCORES: { category: ClimbCategory; minScore: number }[] = [
  { category: "HC", minScore: 80_000 },
  { category: 1, minScore: 64_000 },
  { category: 2, minScore: 32_000 },
  { category: 3, minScore: 16_000 },
  { category: 4, minScore: 8_000 },
]

/** What counts as a climb on this activity - see MAP_STYLES' climbRules. */
export interface ClimbRules {
  // A climb's average gradient must reach this.
  minAvgGradePct: number
  // And its size must reach whichever of these are set.
  minScore?: number
  minAscentM?: number
  // Whether climbs get Strava's Cat 4..HC labels. A cycling convention, so
  // hiking leaves it off.
  categorize: boolean
}

export interface Climb {
  startM: number
  endM: number
  // Into the route's own coordinates (nearest vertex), for the map.
  startIndex: number
  endIndex: number
  lengthM: number
  ascentM: number
  avgGradePct: number
  maxGradePct: number
  // Elevation at the top.
  summitM: number
  // Length (m) x average gradient (%), Strava's measure.
  score: number
  // The Fiets index (climbfinder-style), which also weighs the summit's
  // altitude - kept beside the Strava score to compare the two in the Alps.
  fiets: number
  category: ClimbCategory | null
}

interface Profile {
  distanceM: number[]
  elevation: number[]
}

export function climbCategory(score: number): ClimbCategory | null {
  return CATEGORY_SCORES.find((c) => score >= c.minScore)?.category ?? null
}

export function climbCategoryLabel(category: ClimbCategory): string {
  return category === "HC" ? "HC" : `Cat ${category}`
}

/** H^2 / (D * 10) + (T - 1000) / 1000, the altitude term only above 1000m. */
export function fietsIndex(ascentM: number, lengthM: number, summitM: number): number {
  if (lengthM <= 0) return 0
  return (ascentM * ascentM) / (lengthM * 10) + Math.max(0, (summitM - 1000) / 1000)
}

/**
 * The route's elevation resampled every RESAMPLE_M and smoothed, as one
 * profile per stretch with elevation data: a missing elevation splits the
 * route, so nothing is measured across a gap.
 */
function profiles(cumulative: number[], elevations: (number | null)[]): Profile[] {
  const out: Profile[] = []
  let runStart = -1
  for (let i = 0; i <= cumulative.length; i++) {
    const known = i < cumulative.length && elevations[i] !== null && elevations[i] !== undefined
    if (known && runStart < 0) runStart = i
    if (!known && runStart >= 0) {
      if (i - runStart >= 2) out.push(resample(cumulative, elevations as number[], runStart, i - 1))
      runStart = -1
    }
  }
  return out.filter((p) => p.distanceM.length >= 2)
}

function resample(cumulative: number[], elevations: number[], from: number, to: number): Profile {
  const distanceM: number[] = []
  const raw: number[] = []
  let j = from
  const endM = cumulative[to]
  for (let d = cumulative[from]; ; d += RESAMPLE_M) {
    const at = Math.min(d, endM)
    while (j < to - 1 && cumulative[j + 1] < at) j++
    const span = cumulative[j + 1] - cumulative[j]
    const t = span > 0 ? (at - cumulative[j]) / span : 0
    distanceM.push(at)
    raw.push(elevations[j] + (elevations[j + 1] - elevations[j]) * Math.min(Math.max(t, 0), 1))
    if (at >= endM) break
  }
  const half = Math.floor(SMOOTH_SAMPLES / 2)
  const elevation = raw.map((_, i) => {
    const lo = Math.max(0, i - half)
    const hi = Math.min(raw.length - 1, i + half)
    let sum = 0
    for (let k = lo; k <= hi; k++) sum += raw[k]
    return sum / (hi - lo + 1)
  })
  return { distanceM, elevation }
}

function gradePct(p: Profile, a: number, b: number): number {
  const run = p.distanceM[b] - p.distanceM[a]
  return run > 0 ? ((p.elevation[b] - p.elevation[a]) / run) * 100 : 0
}

/** Steepest climbing average over windowM between samples a and b. */
function steepest(p: Profile, a: number, b: number, windowM: number = MAX_GRADE_WINDOW_M): number {
  const window = Math.max(1, Math.round(windowM / RESAMPLE_M))
  if (b - a < window) return Math.max(0, gradePct(p, a, b))
  let max = 0
  for (let i = a; i + window <= b; i++) max = Math.max(max, gradePct(p, i, i + window))
  return max
}

/** Candidate climbs as [start, summit] sample pairs - see the constants above. */
function candidates(p: Profile): [number, number][] {
  const found: [number, number][] = []
  const e = p.elevation
  let start = 0
  let summit: number | null = null
  for (let i = 1; i < e.length; i++) {
    if (summit === null) {
      if (e[i] < e[start]) start = i
      else if (e[i] > e[start]) summit = i
      continue
    }
    // Strictly higher: a level plateau is flat, not more climb.
    if (e[i] > e[summit]) {
      summit = i
      continue
    }
    const ascent = e[summit] - e[start]
    const tolerance = Math.max(DIP_MIN_M, Math.min(DIP_MAX_M, ascent * DIP_FRACTION))
    if (e[summit] - e[i] > tolerance || p.distanceM[i] - p.distanceM[summit] > MAX_FLAT_M) {
      found.push([start, summit])
      // The next climb starts from the lowest point since this one's top.
      let low: number = summit + 1
      for (let k: number = summit + 1; k <= i; k++) if (e[k] < e[low]) low = k
      start = low
      summit = null
      for (let k = low + 1; k <= i; k++) {
        if (e[k] > e[summit ?? start]) summit = k
      }
    }
  }
  if (summit !== null) found.push([start, summit])
  return found
}

/**
 * Pulls each end in while the TRIM_WINDOW_M there is gentler than `minPct`,
 * then step by step to where the road itself first (and last) reaches it -
 * the window alone would leave half a window of flat on each end.
 */
function trim(p: Profile, start: number, end: number, minPct: number): [number, number] {
  const window = Math.max(1, Math.round(TRIM_WINDOW_M / RESAMPLE_M))
  while (end - start > window && gradePct(p, start, start + window) < minPct) start++
  while (end - start > window && gradePct(p, end - window, end) < minPct) end--
  while (end - start > 1 && gradePct(p, start, start + 1) < minPct) start++
  while (end - start > 1 && gradePct(p, end - 1, end) < minPct) end--
  return [start, end]
}

function nearestIndex(cumulative: number[], distanceM: number): number {
  let lo = 0
  let hi = cumulative.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cumulative[mid] <= distanceM) lo = mid
    else hi = mid
  }
  return distanceM - cumulative[lo] <= cumulative[hi] - distanceM ? lo : hi
}

/**
 * The climbs along a route, in ride order. `elevations` is index-parallel
 * with `coords`; null where a point has no elevation.
 */
export function detectClimbs(
  coords: [number, number][],
  elevations: (number | null)[],
  rules: ClimbRules
): Climb[] {
  const cumulative = cumulativeDistancesM(coords)
  const climbs: Climb[] = []
  for (const p of profiles(cumulative, elevations)) {
    for (const [rawStart, rawEnd] of candidates(p)) {
      const [start, end] = trim(p, rawStart, rawEnd, rules.minAvgGradePct)
      const lengthM = p.distanceM[end] - p.distanceM[start]
      const ascentM = p.elevation[end] - p.elevation[start]
      if (lengthM <= 0 || ascentM <= 0) continue
      const avgGradePct = (ascentM / lengthM) * 100
      const score = lengthM * avgGradePct
      if (avgGradePct < rules.minAvgGradePct) continue
      if (rules.minScore !== undefined && score < rules.minScore) continue
      if (rules.minAscentM !== undefined && ascentM < rules.minAscentM) continue
      const summitM = p.elevation[end]
      climbs.push({
        startM: p.distanceM[start],
        endM: p.distanceM[end],
        startIndex: nearestIndex(cumulative, p.distanceM[start]),
        endIndex: nearestIndex(cumulative, p.distanceM[end]),
        lengthM,
        ascentM,
        avgGradePct,
        maxGradePct: steepest(p, start, end),
        summitM,
        score,
        fiets: fietsIndex(ascentM, lengthM, summitM),
        category: rules.categorize ? climbCategory(score) : null,
      })
    }
  }
  return climbs
}

/** The steepest climbing gradient anywhere on the route, over windowM. */
export function routeMaxGradePct(
  coords: [number, number][],
  elevations: (number | null)[],
  windowM: number = MAX_GRADE_WINDOW_M
): number {
  const cumulative = cumulativeDistancesM(coords)
  return profiles(cumulative, elevations).reduce(
    (max, p) => Math.max(max, steepest(p, 0, p.distanceM.length - 1, windowM)),
    0
  )
}

// --- Route difficulty ---------------------------------------------------

export const DIFFICULTY_LABELS = ["Easy", "Moderate", "Hard", "Very hard"] as const
export type DifficultyLabel = (typeof DIFFICULTY_LABELS)[number]

/**
 * Where Moderate, Hard and Very hard start on each criterion, for one
 * activity - see MAP_STYLES' difficulty. A route is as hard as its hardest
 * criterion.
 */
export interface DifficultyThresholds {
  distanceKm: readonly [number, number, number]
  ascentM: readonly [number, number, number]
  // Steepest over DIFFICULTY_GRADE_WINDOW_M.
  sustainedGradePct: readonly [number, number, number]
  // Omitted on an activity whose climbs aren't categorized.
  climbCategory?: readonly [ClimbCategory, ClimbCategory, ClimbCategory]
}

/** One criterion's say in the rating, for explaining it. */
export interface DifficultyCriterion {
  name: string
  // The route's own figure, e.g. "1,800 m".
  value: string
  level: 0 | 1 | 2 | 3
  label: DifficultyLabel
}

export interface Difficulty {
  level: 0 | 1 | 2 | 3
  label: DifficultyLabel
  // What made it this hard, e.g. "1,800 m of climbing"; null when Easy.
  reason: string | null
  // Every criterion, the deciding one first.
  criteria: DifficultyCriterion[]
}

const CATEGORY_RANK: Record<string, number> = { "4": 1, "3": 2, "2": 3, "1": 4, HC: 5 }

function levelFor(value: number, starts: readonly [number, number, number]): 0 | 1 | 2 | 3 {
  return value >= starts[2] ? 3 : value >= starts[1] ? 2 : value >= starts[0] ? 1 : 0
}

export function routeDifficulty(
  // sustainedGradePct: routeMaxGradePct over DIFFICULTY_GRADE_WINDOW_M.
  route: { distanceM: number; gainM: number; sustainedGradePct: number; climbs: Climb[] },
  thresholds: DifficultyThresholds
): Difficulty {
  const criteria: { name: string; value: string; level: 0 | 1 | 2 | 3; reason: string }[] = [
    {
      name: "Climbing",
      value: `${Math.round(route.gainM).toLocaleString()} m`,
      level: levelFor(route.gainM, thresholds.ascentM),
      reason: `${Math.round(route.gainM).toLocaleString()} m of climbing`,
    },
    {
      name: "Distance",
      value: `${(route.distanceM / 1000).toFixed(0)} km`,
      level: levelFor(route.distanceM / 1000, thresholds.distanceKm),
      reason: `${(route.distanceM / 1000).toFixed(0)} km long`,
    },
    {
      name: "Steepest 1 km",
      value: `${Math.round(route.sustainedGradePct)}%`,
      level: levelFor(route.sustainedGradePct, thresholds.sustainedGradePct),
      reason: `${Math.round(route.sustainedGradePct)}% for a whole km`,
    },
  ]
  const hardest = hardestCategory(route.climbs)
  if (thresholds.climbCategory && hardest !== null) {
    const ranks = thresholds.climbCategory.map((c) => CATEGORY_RANK[String(c)]) as [number, number, number]
    criteria.unshift({
      name: "Hardest climb",
      value: climbCategoryLabel(hardest),
      level: levelFor(CATEGORY_RANK[String(hardest)], ranks),
      reason: `${hardest === "HC" ? "an" : "a"} ${climbCategoryLabel(hardest)} climb`,
    })
  }
  const top = criteria.reduce((best, c) => (c.level > best.level ? c : best))
  return {
    level: top.level,
    label: DIFFICULTY_LABELS[top.level],
    reason: top.level > 0 ? top.reason : null,
    criteria: [top, ...criteria.filter((c) => c !== top)].map(({ name, value, level }) => ({
      name,
      value,
      level,
      label: DIFFICULTY_LABELS[level],
    })),
  }
}

export function hardestCategory(climbs: Climb[]): ClimbCategory | null {
  let best: ClimbCategory | null = null
  for (const climb of climbs) {
    if (climb.category === null) continue
    if (best === null || CATEGORY_RANK[String(climb.category)] > CATEGORY_RANK[String(best)]) best = climb.category
  }
  return best
}
