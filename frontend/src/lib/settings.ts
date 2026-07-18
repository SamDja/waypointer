import { DEFAULT_VISIBLE_POI_TYPES, POI_TYPES } from "@/lib/poiTypes"

const SETTINGS_KEY = "waypointer.settings"
const POI_SEARCH_KEY = "waypointer.poiSearch"
const AVG_SPEED_KEY = "waypointer.avgSpeedKmh"

export interface DeviceSettings {
  device: string
  // Sparse: only populated for POI types the visitor has actually edited
  // a GPX <sym> value for - see SaveCard.tsx, which falls back to each
  // type's suggested default (POI_TYPES[...].defaultGpxSymbol ?? label)
  // for any present-in-output type missing here.
  symbols: Record<string, string>
}

export const DEFAULT_SETTINGS: DeviceSettings = { device: "generic", symbols: {} }

export function loadSettings(): DeviceSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw)
    return {
      device: parsed.device || DEFAULT_SETTINGS.device,
      symbols: parsed.symbols && typeof parsed.symbols === "object" ? parsed.symbols : {},
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: DeviceSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export interface PoiSearchEntry {
  poiType: string
  enabled: boolean
  maxDistanceM: number
}

// Distinct from DeviceSettings above: device/symbol settings are an
// export-time concern, this is a find-time concern (which POI types to
// search for, and how far). Kept in the same file for colocation.
export function loadPoiSearchConfig(): PoiSearchEntry[] {
  const raw = localStorage.getItem(POI_SEARCH_KEY)
  let stored: Record<string, PoiSearchEntry> = {}
  let hasStoredValue = false
  try {
    if (raw) {
      hasStoredValue = true
      const parsed = JSON.parse(raw) as PoiSearchEntry[]
      stored = Object.fromEntries(parsed.map((entry) => [entry.poiType, entry]))
    }
  } catch {
    stored = {}
  }

  // First-ever visit (nothing stored yet) seeds the default-visible set.
  // Otherwise the visitor's own list - whatever they've added or removed
  // via FindPoisCard - is authoritative; re-unioning every searchable
  // registry type here would resurrect a type the visitor deliberately
  // removed. Either way, filter to keys that are still searchable, in case
  // a stored type was desearchified in a later release.
  const keys = hasStoredValue
    ? Object.keys(stored).filter((key) => POI_TYPES.some((cfg) => cfg.key === key && cfg.searchable))
    : DEFAULT_VISIBLE_POI_TYPES

  // Clamp any stored distance into the registry's current bounds.
  return keys.map((key) => {
    const cfg = POI_TYPES.find((c) => c.key === key)!
    const existing = stored[key]
    const maxDistanceM = existing
      ? Math.min(Math.max(existing.maxDistanceM, cfg.minDistanceM!), cfg.maxDistanceM!)
      : cfg.defaultMaxDistanceM!
    return {
      poiType: key,
      enabled: existing?.enabled ?? true,
      maxDistanceM,
    }
  })
}

export function savePoiSearchConfig(entries: PoiSearchEntry[]): void {
  localStorage.setItem(POI_SEARCH_KEY, JSON.stringify(entries))
}

export const DEFAULT_AVG_SPEED_KMH = 20

// Distinct from both settings above: this is a display/estimate-time
// concern (the Import step's duration estimate), not export- or find-time.
export function loadAvgSpeedKmh(): number {
  try {
    const raw = localStorage.getItem(AVG_SPEED_KEY)
    const parsed = raw ? Number(raw) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AVG_SPEED_KMH
  } catch {
    return DEFAULT_AVG_SPEED_KMH
  }
}

export function saveAvgSpeedKmh(speedKmh: number): void {
  localStorage.setItem(AVG_SPEED_KEY, String(speedKmh))
}
