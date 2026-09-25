import { isKnownDevice } from "@/lib/devices"
import {
  DEFAULT_MAP_STYLE_KEY,
  MAP_STYLES,
  activityDefaults,
  defaultRoutingOptions,
  routingOptionSpecsForStyle,
  type RoutingOptions,
} from "@/lib/mapStyles"
import { POI_TYPES } from "@/lib/poiTypes"

const SETTINGS_KEY = "waypointer.settings"
const POI_SEARCH_KEY = "waypointer.poiSearch"
const AVG_SPEED_KEY = "waypointer.avgSpeedKmh"
const MAP_STYLE_KEY = "waypointer.mapStyle"
const OFF_ROUTE_THRESHOLD_KEY = "waypointer.offRouteThreshold"
// Plan-time: the route planner's BRouter options, keyed by map style (each
// style is an activity with its own profile and options).
const ROUTING_OPTIONS_KEY = "waypointer.routingOptions"

/**
 * Reads a per-activity number.
 *
 * Values written before these preferences were per-activity are bare
 * numbers rather than an object. One of those is adopted as the default
 * activity's value, since that is the activity it was set under - handing
 * a walker a cyclist's 20 km/h would be worse than forgetting it.
 */
function loadKeyedNumber(storageKey: string, styleKey: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>)[styleKey]
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
    }
    const legacy = Number(parsed)
    return styleKey === DEFAULT_MAP_STYLE_KEY && Number.isFinite(legacy) && legacy > 0 ? legacy : fallback
  } catch {
    return fallback
  }
}

function saveKeyed(storageKey: string, styleKey: string, value: unknown): void {
  try {
    const raw = localStorage.getItem(storageKey)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    const keyed = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    // Writing the first per-activity value is what converts the old format
    // to the new one, so the legacy value has to be carried across as the
    // default activity's - otherwise a cyclist who tries hiking loses the
    // pace they'd set, at the moment they switch.
    const all = keyed ? (parsed as Record<string, unknown>) : legacyAsDefault(parsed)
    localStorage.setItem(storageKey, JSON.stringify({ ...all, [styleKey]: value }))
  } catch {
    // Not remembering a preference is harmless.
  }
}

function legacyAsDefault(parsed: unknown): Record<string, unknown> {
  if (Array.isArray(parsed)) return { [DEFAULT_MAP_STYLE_KEY]: parsed }
  const legacy = Number(parsed)
  return Number.isFinite(legacy) && legacy > 0 ? { [DEFAULT_MAP_STYLE_KEY]: legacy } : {}
}

export interface DeviceSettings {
  // Which device/output format to save for - per activity, since a FIT
  // course for a bike computer is the obvious answer on a ride and the
  // wrong one on a walk (see mapStyles.ts's ActivityDefaults.device).
  device: string
  // Sparse: only populated for POI types the visitor has actually edited
  // a GPX <sym> value for - see SaveCard.tsx, which falls back to each
  // type's suggested default (POI_TYPES[...].defaultGpxSymbol ?? label)
  // for any present-in-output type missing here.
  //
  // Shared across activities on purpose, unlike device: the <sym> string a
  // visitor wants for water is the same string whichever activity found
  // it.
  symbols: Record<string, string>
}

/**
 * Reads the stored device for an activity.
 *
 * Stored as `{ [styleKey]: device }`. A bare string predates the per-
 * activity split and belongs to the activity it was chosen under, so it's
 * adopted as the default activity's only - the same rule loadKeyedNumber
 * follows. An unknown key (a device dropped in a later release) falls back
 * rather than reaching /api/save, which would 400 on it.
 */
function deviceFor(stored: unknown, styleKey: string): string {
  const fallback = activityDefaults(styleKey).device
  if (typeof stored === "string") {
    return styleKey === DEFAULT_MAP_STYLE_KEY && isKnownDevice(stored) ? stored : fallback
  }
  if (stored && typeof stored === "object") {
    const value = (stored as Record<string, unknown>)[styleKey]
    if (isKnownDevice(value)) return value
  }
  return fallback
}

export function loadSettings(styleKey: string): DeviceSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { device: activityDefaults(styleKey).device, symbols: {} }
    const parsed = JSON.parse(raw)
    return {
      device: deviceFor(parsed?.device, styleKey),
      symbols: parsed?.symbols && typeof parsed.symbols === "object" ? parsed.symbols : {},
    }
  } catch {
    return { device: activityDefaults(styleKey).device, symbols: {} }
  }
}

export function saveSettings(styleKey: string, settings: DeviceSettings): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    const storedDevice = (parsed as { device?: unknown } | null)?.device
    // Writing the first per-activity device is what converts the old flat
    // shape, so a legacy string has to be carried across as the default
    // activity's - otherwise a cyclist who tries hiking loses the format
    // they'd chosen, at the moment they switch.
    const devices =
      typeof storedDevice === "string"
        ? isKnownDevice(storedDevice)
          ? { [DEFAULT_MAP_STYLE_KEY]: storedDevice }
          : {}
        : storedDevice && typeof storedDevice === "object"
          ? (storedDevice as Record<string, string>)
          : {}
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        device: { ...devices, [styleKey]: settings.device },
        symbols: settings.symbols,
      })
    )
  } catch {
    // Not remembering a preference is harmless.
  }
}

export interface PoiSearchEntry {
  poiType: string
  maxDistanceM: number
}

// Distinct from DeviceSettings above: device/symbol settings are an
// export-time concern, this is a find-time concern (which POI types to
// search for, and how far). Kept in the same file for colocation.
export function loadPoiSearchConfig(styleKey: string): PoiSearchEntry[] {
  let stored: Record<string, PoiSearchEntry> = {}
  let hasStoredValue = false
  try {
    const raw = localStorage.getItem(POI_SEARCH_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    // Kept per activity: what you look for on a walk isn't what you look
    // for on a ride. A legacy flat array predates that, and belongs to the
    // activity it was built under.
    const forStyle = Array.isArray(parsed)
      ? styleKey === DEFAULT_MAP_STYLE_KEY
        ? parsed
        : null
      : ((parsed as Record<string, unknown> | null)?.[styleKey] ?? null)
    if (Array.isArray(forStyle)) {
      hasStoredValue = true
      stored = Object.fromEntries((forStyle as PoiSearchEntry[]).map((entry) => [entry.poiType, entry]))
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
    : activityDefaults(styleKey).visiblePoiTypes.filter((key) =>
        POI_TYPES.some((cfg) => cfg.key === key && cfg.searchable),
      )

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

export function savePoiSearchConfig(styleKey: string, entries: PoiSearchEntry[]): void {
  saveKeyed(POI_SEARCH_KEY, styleKey, entries)
}

// Distinct from both settings above: this is a display/estimate-time
// concern (the Import step's duration estimate), not export- or find-time.
// Per activity: 20 km/h and 4.5 km/h are not the same question.
export function loadAvgSpeedKmh(styleKey: string): number {
  return loadKeyedNumber(AVG_SPEED_KEY, styleKey, activityDefaults(styleKey).avgSpeedKmh)
}

export function saveAvgSpeedKmh(styleKey: string, speedKmh: number): void {
  saveKeyed(AVG_SPEED_KEY, styleKey, speedKmh)
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

// Distinct from the settings above: this is an edit-time concern. When a
// route edit strands a waypoint or a selected POI this far from the route,
// it gets auto-unchecked (never deleted) after an explicit confirmation -
// see OffRouteDialog. Editable from inside that dialog, where its effect is
// visible, rather than buried in a settings panel.
export function loadOffRouteThresholdM(styleKey: string): number {
  return loadKeyedNumber(OFF_ROUTE_THRESHOLD_KEY, styleKey, activityDefaults(styleKey).offRouteThresholdM)
}

export function saveOffRouteThresholdM(styleKey: string, thresholdM: number): void {
  saveKeyed(OFF_ROUTE_THRESHOLD_KEY, styleKey, thresholdM)
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
