import { describe, expect, it } from "vitest"
import { cumulativeDistancesM, elevationGainLossM, pointAtDistanceM } from "@/lib/geometry"

describe("elevationGainLossM", () => {
  it("counts a steady climb and descent in full", () => {
    expect(elevationGainLossM([100, 110, 120, 130, 120, 100])).toEqual({ gainM: 30, lossM: 30 })
  })

  it("ignores wobble smaller than the noise threshold", () => {
    expect(elevationGainLossM([100, 102, 99, 101, 98, 100])).toEqual({ gainM: 0, lossM: 0 })
  })

  it("counts a slow climb once it adds up past the threshold", () => {
    // 1m per point: no single step counts, but the climb as a whole does.
    expect(elevationGainLossM([100, 101, 102, 103, 104, 105, 106]).gainM).toBe(5)
  })

  it("doesn't bridge a gap in the elevation data", () => {
    // 100 -> (gap) -> 200 is not a 100m climb.
    expect(elevationGainLossM([100, 100, null, 200, 200])).toEqual({ gainM: 0, lossM: 0 })
  })
})

describe("pointAtDistanceM", () => {
  const coords: [number, number][] = [
    [45.0, 7.0],
    [45.0, 7.01],
    [45.0, 7.02],
  ]
  const cumulative = cumulativeDistancesM(coords)

  it("interpolates between vertices", () => {
    const [lat, lon] = pointAtDistanceM(coords, cumulative, cumulative[1] / 2)!
    expect(lat).toBeCloseTo(45.0, 6)
    expect(lon).toBeCloseTo(7.005, 6)
  })

  it("clamps to the route's ends", () => {
    expect(pointAtDistanceM(coords, cumulative, -10)).toEqual(coords[0])
    expect(pointAtDistanceM(coords, cumulative, 1e9)).toEqual(coords[2])
  })
})
