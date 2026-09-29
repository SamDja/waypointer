import { describe, expect, it } from "vitest"

import { scaleBar } from "@/lib/mapScale"

describe("scaleBar", () => {
  it("rounds down to 1, 2 or 5 times a power of ten", () => {
    expect(scaleBar(437, 100)).toEqual({ widthPx: (100 * 200) / 437, label: "200 m" })
    expect(scaleBar(730, 100)?.label).toBe("500 m")
    expect(scaleBar(150, 100)?.label).toBe("100 m")
  })

  it("switches to kilometres from 1 km", () => {
    expect(scaleBar(1000, 100)).toEqual({ widthPx: 100, label: "1 km" })
    expect(scaleBar(64_000, 100)?.label).toBe("50 km")
  })

  it("draws nothing for a degenerate measurement", () => {
    expect(scaleBar(0, 100)).toBeNull()
    expect(scaleBar(Number.NaN, 100)).toBeNull()
  })
})
