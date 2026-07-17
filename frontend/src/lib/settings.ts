import { POI_TYPES } from "@/lib/poiTypes"

const SETTINGS_KEY = "waypointer.settings"
const POI_SEARCH_KEY = "waypointer.poiSearch"
const AVG_SPEED_KEY = "waypointer.avgSpeedKmh"

export interface DeviceSettings {
  device: string
  waterSymbol: string
}

export const DEFAULT_SETTINGS: DeviceSettings = { device: "generic", waterSymbol: "Water" }

export function loadSettings(): DeviceSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw)
    return {
      device: parsed.device || DEFAULT_SETTINGS.device,
      waterSymbol: parsed.waterSymbol || DEFAULT_SETTINGS.waterSymbol,
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
  let stored: Record<string, PoiSearchEntry> = {}
  try {
    const raw = localStorage.getItem(POI_SEARCH_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as PoiSearchEntry[]
      stored = Object.fromEntries(parsed.map((entry) => [entry.poiType, entry]))
    }
  } catch {
    stored = {}
  }

  // Union in a default entry for any searchable registry type missing from
  // storage (e.g. a POI type added after the user's last visit), and clamp
  // any stored distance into the registry's current bounds. Non-searchable
  // types (most of the registry) have no search config at all.
  return POI_TYPES.filter((cfg) => cfg.searchable).map((cfg) => {
    const existing = stored[cfg.key]
    const maxDistanceM = existing
      ? Math.min(Math.max(existing.maxDistanceM, cfg.minDistanceM!), cfg.maxDistanceM!)
      : cfg.defaultMaxDistanceM!
    return {
      poiType: cfg.key,
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
