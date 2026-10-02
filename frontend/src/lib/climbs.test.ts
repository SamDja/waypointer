import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  climbCategory,
  detectClimbs,
  fietsIndex,
  routeDifficulty,
  routeMaxGradePct,
  type Climb,
  type ClimbRules,
  type DifficultyThresholds,
} from "@/lib/climbs"
import { cumulativeDistancesM } from "@/lib/geometry"

const CYCLING: ClimbRules = { minAvgGradePct: 3, minScore: 8000, categorize: true }
const HIKING: ClimbRules = { minAvgGradePct: 3, minAscentM: 100, categorize: false }

// A straight route north along a meridian, one point every 10m, with its
// elevation given as a function of the distance from the start.
const M_PER_DEG_LAT = 111_195
function route(lengthM: number, elevationAt: (d: number) => number | null) {
  const coords: [number, number][] = []
  const elevations: (number | null)[] = []
  for (let d = 0; d <= lengthM; d += 10) {
    coords.push([46 + d / M_PER_DEG_LAT, 11])
    elevations.push(elevationAt(d))
  }
  // The route's own distances, so expectations don't depend on the
  // approximation above.
  const total = cumulativeDistancesM(coords).at(-1)!
  return { coords, elevations, total }
}

// Flat, then `lengthM` at `pct`, then flat at the top.
function singleClimb(lengthM: number, pct: number, flatM = 2000) {
  return route(flatM * 2 + lengthM, (d) =>
    d < flatM ? 500 : d < flatM + lengthM ? 500 + ((d - flatM) * pct) / 100 : 500 + (lengthM * pct) / 100
  )
}

describe("detectClimbs", () => {
  it("finds a steady climb with its length, ascent and category", () => {
    const { coords, elevations } = singleClimb(8000, 6)
    const climbs = detectClimbs(coords, elevations, CYCLING)
    expect(climbs).toHaveLength(1)
    const [climb] = climbs
    expect(climb.lengthM).toBeGreaterThan(7800)
    expect(climb.lengthM).toBeLessThan(8200)
    expect(climb.ascentM).toBeGreaterThan(465)
    expect(climb.ascentM).toBeLessThan(485)
    expect(climb.avgGradePct).toBeCloseTo(6, 0)
    expect(climb.maxGradePct).toBeCloseTo(6, 0)
    // 8km x 6% = 48,000: Cat 2.
    expect(climb.category).toBe(2)
    expect(climb.startM).toBeGreaterThan(1900)
    expect(climb.startM).toBeLessThan(2100)
  })

  it("tolerates a short dip inside a climb", () => {
    // 3km at 7%, a 200m drop of 6m, then 3km more at 7%.
    const { coords, elevations } = route(10_000, (d) => {
      if (d < 2000) return 500
      if (d < 5000) return 500 + (d - 2000) * 0.07
      if (d < 5200) return 710 - (d - 5000) * 0.03
      if (d < 8200) return 704 + (d - 5200) * 0.07
      return 914
    })
    expect(detectClimbs(coords, elevations, CYCLING)).toHaveLength(1)
  })

  it("splits two climbs separated by a real descent", () => {
    // Up 300m, down 200m, up 300m.
    const { coords, elevations } = route(16_000, (d) => {
      if (d < 1000) return 500
      if (d < 6000) return 500 + (d - 1000) * 0.06
      if (d < 9000) return 800 - (d - 6000) * (200 / 3000)
      if (d < 14_000) return 600 + (d - 9000) * 0.06
      return 900
    })
    const climbs = detectClimbs(coords, elevations, CYCLING)
    expect(climbs).toHaveLength(2)
    expect(climbs[0].endM).toBeLessThan(climbs[1].startM)
  })

  it("splits a climb broken by a long flat", () => {
    const { coords, elevations } = route(12_000, (d) => {
      if (d < 1000) return 500
      if (d < 5000) return 500 + (d - 1000) * 0.06
      if (d < 7000) return 740
      if (d < 11_000) return 740 + (d - 7000) * 0.06
      return 980
    })
    expect(detectClimbs(coords, elevations, CYCLING)).toHaveLength(2)
  })

  it("finds nothing in noise on the flat", () => {
    const { coords, elevations } = route(10_000, (d) => 500 + 3 * Math.sin(d / 37) + 2 * Math.cos(d / 11))
    expect(detectClimbs(coords, elevations, CYCLING)).toEqual([])
  })

  it("ignores a long drag under the minimum gradient", () => {
    const { coords, elevations } = singleClimb(10_000, 2)
    expect(detectClimbs(coords, elevations, CYCLING)).toEqual([])
  })

  it("trims a false flat off the start", () => {
    // 3km at 1% before 4km at 7%: the climb starts where the 7% does.
    const { coords, elevations } = route(10_000, (d) => {
      if (d < 3000) return 500 + d * 0.01
      if (d < 7000) return 530 + (d - 3000) * 0.07
      return 810
    })
    const [climb] = detectClimbs(coords, elevations, CYCLING)
    expect(climb.startM).toBeGreaterThan(2800)
    expect(climb.avgGradePct).toBeGreaterThan(6.5)
  })

  it("doesn't measure a climb across missing elevation", () => {
    const { coords, elevations } = singleClimb(8000, 6)
    // Blank out the middle of the climb: two halves, neither bridging the gap.
    for (let i = 550; i < 650; i++) elevations[i] = null
    const climbs = detectClimbs(coords, elevations, CYCLING)
    for (const climb of climbs) expect(climb.endM < 5600 || climb.startM > 6400).toBe(true)
  })

  it("never categorizes on hiking, and keeps climbs by ascent", () => {
    const { coords, elevations } = singleClimb(1000, 15)
    const climbs = detectClimbs(coords, elevations, HIKING)
    expect(climbs).toHaveLength(1)
    expect(climbs[0].category).toBeNull()
    // 50m isn't a climb on foot.
    const small = singleClimb(500, 10)
    expect(detectClimbs(small.coords, small.elevations, HIKING)).toEqual([])
  })

  it("maps climbs back to the route's own vertices", () => {
    const { coords, elevations } = singleClimb(8000, 6)
    const [climb] = detectClimbs(coords, elevations, CYCLING)
    expect(climb.startIndex).toBeGreaterThan(190)
    expect(climb.startIndex).toBeLessThan(210)
    expect(climb.endIndex).toBeGreaterThan(climb.startIndex)
  })
})

describe("climbCategory", () => {
  it("follows Strava's score thresholds", () => {
    expect(climbCategory(7_999)).toBeNull()
    expect(climbCategory(8_000)).toBe(4)
    expect(climbCategory(16_000)).toBe(3)
    expect(climbCategory(32_000)).toBe(2)
    expect(climbCategory(64_000)).toBe(1)
    expect(climbCategory(79_999)).toBe(1)
    expect(climbCategory(80_000)).toBe("HC")
  })
})

describe("fietsIndex", () => {
  it("weighs the summit's altitude only above 1000m", () => {
    // Alpe d'Huez: 1071m over 13.8km to 1850m - about 9.2.
    expect(fietsIndex(1071, 13_800, 1850)).toBeCloseTo(9.16, 1)
    expect(fietsIndex(100, 1000, 600)).toBeCloseTo(1, 5)
  })
})

describe("routeMaxGradePct", () => {
  it("is the steepest stretch, not one noisy step", () => {
    const { coords, elevations } = singleClimb(2000, 9)
    expect(routeMaxGradePct(coords, elevations)).toBeCloseTo(9, 0)
  })
})

const CYCLING_DIFFICULTY: DifficultyThresholds = {
  distanceKm: [40, 80, 140],
  ascentM: [500, 1200, 2200],
  maxGradePct: [8, 12, 16],
  climbCategory: [3, 1, "HC"],
}

function climbOf(category: Climb["category"]): Climb {
  return {
    startM: 0, endM: 1, startIndex: 0, endIndex: 1, lengthM: 1, ascentM: 1, avgGradePct: 1,
    maxGradePct: 1, summitM: 1, score: 1, fiets: 0, category,
  }
}

describe("routeDifficulty", () => {
  it("is easy when nothing reaches a threshold", () => {
    const difficulty = routeDifficulty({ distanceM: 30_000, gainM: 200, maxGradePct: 5, climbs: [] }, CYCLING_DIFFICULTY)
    expect(difficulty.label).toBe("Easy")
    expect(difficulty.reason).toBeNull()
    expect(difficulty.criteria.every((c) => c.level === 0)).toBe(true)
  })

  it("takes the hardest criterion and names it", () => {
    const difficulty = routeDifficulty(
      { distanceM: 60_000, gainM: 1800, maxGradePct: 9, climbs: [] },
      CYCLING_DIFFICULTY
    )
    expect(difficulty.label).toBe("Hard")
    expect(difficulty.reason).toBe(`${(1800).toLocaleString()} m of climbing`)
    // Every criterion, for the explanation - the deciding one first.
    expect(difficulty.criteria.map((c) => [c.name, c.label])).toEqual([
      ["Climbing", "Hard"],
      ["Distance", "Moderate"],
      ["Steepest 100 m", "Moderate"],
    ])
  })

  it("counts the hardest climb's category", () => {
    const difficulty = routeDifficulty(
      { distanceM: 30_000, gainM: 300, maxGradePct: 5, climbs: [climbOf(4), climbOf("HC")] },
      CYCLING_DIFFICULTY
    )
    expect(difficulty.label).toBe("Very hard")
    expect(difficulty.reason).toBe("an HC climb")
  })

  it("ignores categories on an activity without them", () => {
    const { climbCategory: _, ...hiking } = CYCLING_DIFFICULTY
    const difficulty = routeDifficulty({ distanceM: 1000, gainM: 0, maxGradePct: 0, climbs: [climbOf("HC")] }, hiking)
    expect(difficulty.level).toBe(0)
  })
})

// The same profile and expected climbs tests/test_climbs.py checks against the
// Python port (src/waypointer/climbs.py), so a change to either implementation
// alone fails one of the two suites.
describe("parity with the backend's climbs.py", () => {
  it("finds the climbs the shared fixture expects", () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../tests/fixtures/climb_profile.json"), "utf8")
    ) as {
      distances_m: number[]
      elevations: (number | null)[]
      expected_climbs: {
        start_index: number
        end_index: number
        length_m: number
        ascent_m: number
        max_grade_pct: number
        category: string | null
      }[]
      expected_max_grade_pct: number
    }
    const coords = fixture.distances_m.map((d): [number, number] => [46 + d / M_PER_DEG_LAT, 11])
    const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places
    const climbs = detectClimbs(coords, fixture.elevations, CYCLING).map((c) => ({
      start_index: c.startIndex,
      end_index: c.endIndex,
      length_m: round(c.lengthM, 1),
      ascent_m: round(c.ascentM, 1),
      max_grade_pct: round(c.maxGradePct, 2),
      category: c.category === null ? null : String(c.category),
    }))
    expect(climbs).toEqual(fixture.expected_climbs)
    expect(round(routeMaxGradePct(coords, fixture.elevations), 2)).toBe(fixture.expected_max_grade_pct)
  })
})
