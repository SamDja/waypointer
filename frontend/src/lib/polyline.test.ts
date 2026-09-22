import { describe, expect, it } from "vitest"
import { encodePolyline } from "./polyline"

describe("encodePolyline", () => {
  it("matches Google's documented example", () => {
    const points: [number, number][] = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]
    expect(encodePolyline(points)).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
  })

  it("encodes at a lower precision, rounding each point", () => {
    // 46.06352, 11.12864 -> 4606, 1113 at 2 decimals; the second point
    // rounds to the same place, so its deltas are zero ("??").
    expect(encodePolyline([[46.06352, 11.12864], [46.0648, 11.1301]], 2)).toBe(
      encodePolyline([[46.06, 11.13]], 2) + "??"
    )
  })

  it("is empty for no points", () => {
    expect(encodePolyline([])).toBe("")
  })
})
