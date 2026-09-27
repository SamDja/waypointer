// Which OSM tags can point at a photo of an element - the keys the backend's
// photos.py reads (PHOTO_TAG_KEY there; keep the two in sync by hand, same
// convention as poiTypes.ts). Each may also appear numbered (`panoramax:1`).
// `wikidata` counts because its P18 statement can name a Commons image.
const PHOTO_TAG_KEY = /^(image|wikimedia_commons|panoramax|mapillary|wikidata)(:\d+)?$/

export function isPhotoTag(key: string): boolean {
  return PHOTO_TAG_KEY.test(key)
}

// The subset of an element's tags worth sending to /api/poi-photos. Empty
// means there's nothing to look up, so the popup can go straight to asking
// the visitor for a photo.
export function photoTags(tags: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tags).filter(([key]) => isPhotoTag(key)))
}

export const PHOTO_SOURCE_LABELS: Record<string, string> = {
  commons: "Wikimedia Commons",
  panoramax: "Panoramax",
  mapillary: "Mapillary",
  web: "the web",
}
