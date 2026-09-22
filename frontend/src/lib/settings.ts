import {
  DEFAULT_MAP_STYLE_KEY,
  MAP_STYLES,
  defaultRoutingOptions,
  routingOptionSpecsForStyle,
  type RoutingOptions,
} from "@/lib/mapStyles"
import { DEFAULT_VISIBLE_POI_TYPES, POI_TYPES } from "@/lib/poiTypes"

const SETTINGS_KEY = "waypointer.settings"
const POI_SEARCH_KEY = "waypointer.poiSearch"
const AVG_SPEED_KEY = "waypointer.avgSpeedKmh"
const MAP_STYLE_KEY = "waypointer.mapStyle"
const OFF_ROUTE_THRESHOLD_KEY = "waypointer.offRouteThreshold"
// Plan-time: the route planner's BRouter options, keyed by map style (each
// style is an activity with its own profile and options).
const ROUTING_OPTIONS_KEY = "waypointer.routingOptions"

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

// Distinct from the settings above: this is a display-time concern (which
// map style to render), not export- or find-time.
export function loadMapStyleKey(): string {
  try {
    const raw = localStorage.getItem(MAP_STYLE_KEY)
    return raw && MAP_STYLES.some((s) => s.key === raw) ? raw : DEFAULT_MAP_STYLE_KEY
  } catch {
    return DEFAULT_MAP_STYLE_KEY
  }
}

export function saveMapStyleKey(key: string): void {
  localStorage.setItem(MAP_STYLE_KEY, key)
}

export const DEFAULT_OFF_ROUTE_THRESHOLD_M = 500

// Distinct from the settings above: this is an edit-time concern. When a
// route edit strands a waypoint or a selected POI this far from the route,
// it gets auto-unchecked (never deleted) after an explicit confirmation -
// see OffRouteDialog. Editable from inside that dialog, where its effect is
// visible, rather than buried in a settings panel.
export function loadOffRouteThresholdM(): number {
  try {
    const raw = localStorage.getItem(OFF_ROUTE_THRESHOLD_KEY)
    const parsed = raw ? Number(raw) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OFF_ROUTE_THRESHOLD_M
  } catch {
    return DEFAULT_OFF_ROUTE_THRESHOLD_M
  }
}

export function saveOffRouteThresholdM(thresholdM: number): void {
  localStorage.setItem(OFF_ROUTE_THRESHOLD_KEY, String(thresholdM))
}

/**
 * The saved routing options for a style, on top of its defaults. Anything
 * saved that the style no longer offers, or of the wrong kind or value, is
 * dropped - the backend would reject it.
 */
export function loadRoutingOptions(styleKey: string): RoutingOptions {
  try {
    const raw = localStorage.getItem(ROUTING_OPTIONS_KEY)
    const saved = raw ? (JSON.parse(raw) as Record<string, unknown>)[styleKey] : undefined
    return sanitizeRoutingOptions(styleKey, saved)
  } catch {
    // Unreadable or blocked storage: fall back to the defaults.
    return sanitizeRoutingOptions(styleKey, undefined)
  }
}

/**
 * Stored routing options made safe for a style: its defaults, overlaid with
 * whatever `saved` has that the style still offers, of the right kind and
 * value. Anything else is dropped - the backend would reject it.
 */
export function sanitizeRoutingOptions(styleKey: string, saved: unknown): RoutingOptions {
  const specs = routingOptionSpecsForStyle(styleKey)
  const options = defaultRoutingOptions(specs)
  if (!saved || typeof saved !== "object") return options
  const values = saved as Record<string, unknown>
  for (const spec of specs) {
    const value = values[spec.key]
    if (spec.kind === "toggle" && typeof value === "boolean") options[spec.key] = value
    if (spec.kind === "choice" && spec.choices.some((c) => c.value === value)) options[spec.key] = value as number
  }
  return options
}

export function saveRoutingOptions(styleKey: string, options: RoutingOptions): void {
  try {
    const raw = localStorage.getItem(ROUTING_OPTIONS_KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, RoutingOptions>) : {}
    localStorage.setItem(ROUTING_OPTIONS_KEY, JSON.stringify({ ...all, [styleKey]: options }))
  } catch {
    // Not remembering a preference is harmless.
  }
}
