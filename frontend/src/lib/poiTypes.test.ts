import { describe, expect, it } from "vitest"
import { POI_TYPES, mostSpecificPerElement, poiSpecificity } from "@/lib/poiTypes"

const c = (osm_id: number, poi_type: string) => ({ osm_id, poi_type })

describe("mostSpecificPerElement", () => {
  it("keeps the more specific type when one element matched both", () => {
    // The real case: node 6337835209 is tourism=information AND
    // highway=trailhead, so both searches return it.
    const resolved = mostSpecificPerElement([c(6337835209, "info"), c(6337835209, "trailhead")])
    expect(resolved).toEqual([c(6337835209, "trailhead")])
  })

  it("resolves the same way whichever type's results arrived first", () => {
    expect(mostSpecificPerElement([c(1, "trailhead"), c(1, "info")])).toEqual([c(1, "trailhead")])
  })

  it("keeps a broader type when it is the only one searched", () => {
    // Searching Info alone must still find the board - nothing more
    // specific is present to beat it.
    expect(mostSpecificPerElement([c(6337835209, "info")])).toEqual([c(6337835209, "info")])
    expect(mostSpecificPerElement([c(2, "shopping")])).toEqual([c(2, "shopping")])
  })

  it("lets every shop type beat the shopping catch-all", () => {
    for (const specific of ["groceries", "winery", "bike_shop"]) {
      expect(mostSpecificPerElement([c(3, "shopping"), c(3, specific)])).toEqual([c(3, specific)])
    }
  })

  it("leaves different elements alone, and keeps the input identity", () => {
    const distinct = [c(1, "info"), c(2, "trailhead"), c(3, "water")]
    expect(mostSpecificPerElement(distinct)).toBe(distinct)
  })

  it("treats an unknown or unranked type as 0", () => {
    expect(poiSpecificity("nope")).toBe(0)
    expect(poiSpecificity("water")).toBe(0)
  })

  it("only ranks types that actually collide", () => {
    // A rank is a claim that two searched types really overlap. Keeping the
    // set small is the point, so this pins which ones carry one.
    const ranked = POI_TYPES.filter((t) => (t.specificity ?? 0) !== 0).map((t) => t.key)
    expect(ranked.sort()).toEqual(["shopping", "trailhead"])
  })
})
