// Human-readable labels for raw OSM tags shown in map popups (see
// RouteMap.tsx's OsmTagList) - mirrors the lookup-table convention used by
// poiTypes.ts's POI_TYPES, just keyed by raw OSM tag key instead of poi_type.

// Friendly labels only - whether a value renders as a link is inferred
// generically from the key/value shape (see inferHref) rather than curated
// per key, so arbitrary contact:* / social tags (facebook, instagram, ...)
// still come out clickable without needing an entry here.
const OSM_TAG_LABELS: Record<string, string> = {
  opening_hours: "Opening hours",
  phone: "Phone",
  "contact:phone": "Phone",
  mobile: "Mobile",
  fax: "Fax",
  website: "Website",
  "contact:website": "Website",
  url: "Website",
  email: "Email",
  "contact:email": "Email",
  "contact:facebook": "Facebook",
  "contact:instagram": "Instagram",
  "contact:twitter": "Twitter",
  cuisine: "Cuisine",
  wheelchair: "Wheelchair access",
  internet_access: "Internet access",
  fee: "Fee",
  operator: "Operator",
  brand: "Brand",
  drinking_water: "Drinking water",
  bottle: "Bottle refill",
  "addr:housenumber": "House number",
  "addr:street": "Street",
  "addr:city": "City",
  "addr:postcode": "Postcode",
  "addr:country": "Country",
  // Mapper-set "I verified this in the field" dates - distinct from
  // PoiLookupResult.last_edited (OSM's own edit metadata). Kept, not
  // excluded, since they're a candidate signal for a future "this hasn't
  // been checked in a while" nudge.
  check_date: "Last verified",
  "survey:date": "Last verified",
}

// Keys with no useful info for a visitor deciding whether to add this POI to
// their route - pure OSM bookkeeping/provenance, not shown at all.
const EXCLUDED_OSM_TAGS = new Set(["source", "wikidata", "wikipedia", "ref"])

function humanizeKey(key: string): string {
  return key
    .replace(/^contact:/, "")
    .replace(/[_:]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// Infers a clickable href from the key/value shape rather than a curated
// per-key map - covers phone/mobile/fax (tel:), email (mailto:), any
// value that's already a full URL (website, contact:facebook,
// contact:instagram, ...), and bare domains on a website/url-ish key.
function inferHref(key: string, value: string): string | undefined {
  const k = key.toLowerCase()
  if (k.includes("email")) return `mailto:${value}`
  if (k.includes("phone") || k.includes("mobile") || k.includes("fax")) {
    return `tel:${value.replace(/\s+/g, "")}`
  }
  if (/^https?:\/\//i.test(value)) return value
  if (k.includes("website") || k === "url" || k.includes("facebook") || k.includes("instagram") || k.includes("twitter")) {
    return `https://${value}`
  }
  return undefined
}

// Long values (URLs especially) would otherwise force the popup wider than
// its maxWidth - shown as "first 10…last 10" rather than wrapped/ellipsized
// by CSS so the interesting parts (domain, handle) both stay visible. Kept
// as a fallback for whatever socialHandleDisplay doesn't recognize.
const TRUNCATE_HEAD = 10
const TRUNCATE_TAIL = 10

export function truncateOsmValue(value: string): string {
  if (value.length <= TRUNCATE_HEAD + TRUNCATE_TAIL + 3) return value
  return `${value.slice(0, TRUNCATE_HEAD)}...${value.slice(-TRUNCATE_TAIL)}`
}

// Known social platforms always start with the same domain, so trimming
// that fixed prefix leaves just the handle/path - much more readable than
// mid-string truncation for e.g. a Facebook page URL.
const SOCIAL_URL_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "youtube.com",
]

function socialHandleDisplay(value: string): string | undefined {
  const normalized = value.replace(/^https?:\/\//i, "").replace(/^www\./i, "")
  const domain = SOCIAL_URL_DOMAINS.find((d) => normalized.toLowerCase().startsWith(d))
  if (!domain) return undefined
  let handle = normalized.slice(domain.length).replace(/^\//, "")
  // facebook.com/pg/<name>/ is just a Page-type URL, not part of the
  // handle itself - most Facebook OSM tags are page links, so this is the
  // common case worth trimming.
  if (domain === "facebook.com") handle = handle.replace(/^pg\//i, "")
  handle = handle.replace(/\/$/, "")
  return handle || domain
}

// Mapper-set "I verified this in the field" tags (see OSM_TAG_LABELS) -
// their value is a date, so the row gets an exact-time tooltip like
// PoiLookupResult.last_edited does (see formatExactDateTime).
const DATE_TAG_KEYS = new Set(["check_date", "survey:date"])

export interface FormattedOsmTag {
  key: string
  label: string
  value: string
  displayValue: string
  href?: string
  isDate: boolean
  // OSM wiki's Key:* page convention covers essentially every documented
  // tag key, so this is derived generically rather than curated per tag.
  wikiUrl: string
}

export function isExcludedOsmTag(key: string): boolean {
  return EXCLUDED_OSM_TAGS.has(key)
}

export function formatOsmTag(key: string, value: string): FormattedOsmTag {
  return {
    key,
    label: OSM_TAG_LABELS[key] ?? humanizeKey(key),
    value,
    displayValue: truncateOsmValue(socialHandleDisplay(value) ?? value),
    href: inferHref(key, value),
    isDate: DATE_TAG_KEYS.has(key),
    wikiUrl: `https://wiki.openstreetmap.org/wiki/Key:${encodeURIComponent(key)}`,
  }
}

// Formats an ISO 8601 date/timestamp as e.g. "2 years ago". Falls back to
// the raw string if it isn't parseable (a mapper's check_date isn't always
// strictly ISO 8601).
export function formatRelativeDate(isoDate: string): string {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return isoDate

  const diffMs = date.getTime() - Date.now()
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

  const diffYears = Math.round(diffDays / 365)
  if (Math.abs(diffYears) >= 1) return rtf.format(diffYears, "year")
  const diffMonths = Math.round(diffDays / 30)
  if (Math.abs(diffMonths) >= 1) return rtf.format(diffMonths, "month")
  return rtf.format(diffDays, "day")
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

// Formats an ISO 8601 date/timestamp as "HH:MM - dd/mm/yyyy" for the exact-
// time tooltip next to formatRelativeDate's fuzzy text. A date-only value
// (a mapper's check_date/survey:date, no time-of-day) is read with UTC
// getters rather than local ones - otherwise converting a UTC midnight to a
// negative-offset timezone shifts it back a calendar day, which would show
// the wrong date for a field that never had a time component to begin with.
export function formatExactDateTime(isoDate: string): string {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return isoDate

  const useUtc = DATE_ONLY_RE.test(isoDate)
  const pad = (n: number) => String(n).padStart(2, "0")
  const hh = pad(useUtc ? date.getUTCHours() : date.getHours())
  const mm = pad(useUtc ? date.getUTCMinutes() : date.getMinutes())
  const dd = pad(useUtc ? date.getUTCDate() : date.getDate())
  const mo = pad((useUtc ? date.getUTCMonth() : date.getMonth()) + 1)
  const yyyy = useUtc ? date.getUTCFullYear() : date.getFullYear()
  return `${hh}:${mm} - ${dd}/${mo}/${yyyy}`
}
