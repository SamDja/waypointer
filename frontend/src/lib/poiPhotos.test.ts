import { describe, expect, it } from "vitest"

import { isExcludedOsmTag } from "./osmTagLabels"
import { isPhotoTag, photoTags } from "./poiPhotos"

describe("photoTags", () => {
  it("keeps the photo keys, numbered ones included", () => {
    expect(
      photoTags({
        name: "Rifugio",
        image: "https://example.org/a.jpg",
        "panoramax:1": "id",
        wikidata: "Q1",
        "image:source": "survey",
        "brand:wikidata": "Q2",
      }),
    ).toEqual({ image: "https://example.org/a.jpg", "panoramax:1": "id", wikidata: "Q1" })
  })

  it("is empty for an element with no photo", () => {
    expect(photoTags({ amenity: "drinking_water" })).toEqual({})
  })
})

describe("isPhotoTag", () => {
  it.each(["image", "wikimedia_commons", "panoramax", "mapillary:0", "wikidata"])("%s is a photo tag", (key) => {
    expect(isPhotoTag(key)).toBe(true)
  })

  it.each(["image:source", "images", "mapillary:x", "name"])("%s is not", (key) => {
    expect(isPhotoTag(key)).toBe(false)
  })

  it("keeps photo tags out of the tag table", () => {
    expect(isExcludedOsmTag("panoramax:2")).toBe(true)
    expect(isExcludedOsmTag("opening_hours")).toBe(false)
  })
})
