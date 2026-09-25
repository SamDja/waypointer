import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DEVICES } from "@/lib/devices"
import { MAP_STYLES } from "@/lib/mapStyles"
import {
  loadAvgSpeedKmh,
  loadSettings,
  loadOffRouteThresholdM,
  loadPoiSearchConfig,
  saveAvgSpeedKmh,
  saveOffRouteThresholdM,
  savePoiSearchConfig,
  saveSettings,
} from "@/lib/settings"

/**
 * Preferences are stored per activity, because a walk and a ride disagree
 * about every one of them. Two things are worth pinning: that switching
 * activity can't clobber the other one's setting, and that a value saved
 * before these were keyed is still honoured for the activity it was set
 * under - a walker inheriting a cyclist's 20 km/h would be worse than
 * forgetting the preference entirely.
 */

const CYCLING = "road_cycling"
const HIKING = "hiking"

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  }
}

let store: Storage

beforeEach(() => {
  store = memoryStorage()
  vi.stubGlobal("localStorage", store)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("per-activity preferences", () => {
  it("starts each activity on its own defaults", () => {
    expect(loadAvgSpeedKmh(CYCLING)).toBe(20)
    expect(loadAvgSpeedKmh(HIKING)).toBe(4.5)

    expect(loadOffRouteThresholdM(CYCLING)).toBe(500)
    expect(loadOffRouteThresholdM(HIKING)).toBeLessThan(500)

    expect(loadPoiSearchConfig(CYCLING).map((e) => e.poiType)).toEqual(["water"])
    // A walk looks for more than water - what it's aimed at, and shelter.
    const hikingTypes = loadPoiSearchConfig(HIKING).map((e) => e.poiType)
    expect(hikingTypes).toContain("water")
    expect(hikingTypes.length).toBeGreaterThan(1)

    // A FIT course is shaped for a bike computer; a walk saves as GPX.
    expect(loadSettings(CYCLING).device).toBe("wahoo_elemnt_roam_v3")
    expect(loadSettings(HIKING).device).toBe("generic")
  })

  it("offers every activity a device that actually exists", () => {
    for (const style of MAP_STYLES) {
      expect(DEVICES.map((d) => d.key)).toContain(style.defaults.device)
    }
  })

  it("keeps one activity's settings out of the other's", () => {
    saveAvgSpeedKmh(HIKING, 3)
    saveOffRouteThresholdM(HIKING, 80)
    savePoiSearchConfig(HIKING, [{ poiType: "summit", maxDistanceM: 120 }])

    expect(loadAvgSpeedKmh(HIKING)).toBe(3)
    expect(loadOffRouteThresholdM(HIKING)).toBe(80)
    expect(loadPoiSearchConfig(HIKING).map((e) => e.poiType)).toEqual(["summit"])

    // The bike is untouched, still on its own defaults.
    expect(loadAvgSpeedKmh(CYCLING)).toBe(20)
    expect(loadOffRouteThresholdM(CYCLING)).toBe(500)
    expect(loadPoiSearchConfig(CYCLING).map((e) => e.poiType)).toEqual(["water"])
  })

  it("round-trips both activities independently", () => {
    saveAvgSpeedKmh(CYCLING, 28)
    saveAvgSpeedKmh(HIKING, 3.5)
    expect(loadAvgSpeedKmh(CYCLING)).toBe(28)
    expect(loadAvgSpeedKmh(HIKING)).toBe(3.5)

    saveSettings(CYCLING, { device: "generic", symbols: {} })
    saveSettings(HIKING, { device: "wahoo_elemnt_roam_v3", symbols: {} })
    expect(loadSettings(CYCLING).device).toBe("generic")
    expect(loadSettings(HIKING).device).toBe("wahoo_elemnt_roam_v3")
  })

  it("shares the GPX symbol overrides across activities", () => {
    // Unlike the device, a <sym> string is the same answer whichever
    // activity found the POI.
    saveSettings(HIKING, { device: "generic", symbols: { water: "Drinking Water" } })
    expect(loadSettings(CYCLING).symbols).toEqual({ water: "Drinking Water" })
  })

  describe("values saved before these were per-activity", () => {
    it("adopts a legacy speed for cycling, and never for hiking", () => {
      store.setItem("waypointer.avgSpeedKmh", "26")
      expect(loadAvgSpeedKmh(CYCLING)).toBe(26)
      // The number was chosen on a bike; handing it to a walker would read
      // as the app thinking they walk at 26 km/h.
      expect(loadAvgSpeedKmh(HIKING)).toBe(4.5)
    })

    it("adopts a legacy off-route threshold the same way", () => {
      store.setItem("waypointer.offRouteThreshold", "750")
      expect(loadOffRouteThresholdM(CYCLING)).toBe(750)
      expect(loadOffRouteThresholdM(HIKING)).toBeLessThan(500)
    })

    it("adopts a legacy POI list for cycling, and seeds hiking fresh", () => {
      store.setItem(
        "waypointer.poiSearch",
        JSON.stringify([
          { poiType: "water", maxDistanceM: 60 },
          { poiType: "coffee", maxDistanceM: 100 },
        ]),
      )
      expect(loadPoiSearchConfig(CYCLING).map((e) => e.poiType)).toEqual(["water", "coffee"])
      expect(loadPoiSearchConfig(HIKING).map((e) => e.poiType)).toContain("summit")
    })

    it("doesn't let a later save destroy the legacy value", () => {
      store.setItem("waypointer.avgSpeedKmh", "26")
      // Writing hiking's value is what converts the storage to the keyed
      // format, so this is the moment the old number could be lost - which
      // for the visitor looks like switching activity wiping their pace.
      saveAvgSpeedKmh(HIKING, 4)
      expect(loadAvgSpeedKmh(HIKING)).toBe(4)
      expect(loadAvgSpeedKmh(CYCLING)).toBe(26)
    })

    it("adopts a legacy device for cycling, and keeps it across the conversion", () => {
      store.setItem(
        "waypointer.settings",
        JSON.stringify({ device: "wahoo_elemnt_roam_v3", symbols: { water: "Water" } }),
      )
      expect(loadSettings(CYCLING).device).toBe("wahoo_elemnt_roam_v3")
      // A ROAM is a bike computer, so the choice says nothing about a walk.
      expect(loadSettings(HIKING).device).toBe("generic")

      saveSettings(HIKING, { device: "generic", symbols: { water: "Water" } })
      expect(loadSettings(CYCLING).device).toBe("wahoo_elemnt_roam_v3")
      expect(loadSettings(CYCLING).symbols).toEqual({ water: "Water" })
    })

    it("carries a legacy POI list across the same conversion", () => {
      store.setItem("waypointer.poiSearch", JSON.stringify([{ poiType: "coffee", maxDistanceM: 100 }]))
      savePoiSearchConfig(HIKING, [{ poiType: "summit", maxDistanceM: 120 }])
      expect(loadPoiSearchConfig(CYCLING).map((e) => e.poiType)).toEqual(["coffee"])
      expect(loadPoiSearchConfig(HIKING).map((e) => e.poiType)).toEqual(["summit"])
    })
  })

  it("falls back to the defaults on unusable stored values", () => {
    store.setItem("waypointer.avgSpeedKmh", "not json")
    store.setItem("waypointer.offRouteThreshold", JSON.stringify({ [HIKING]: -5 }))
    store.setItem("waypointer.poiSearch", JSON.stringify({ [HIKING]: "nonsense" }))

    expect(loadAvgSpeedKmh(CYCLING)).toBe(20)
    expect(loadOffRouteThresholdM(HIKING)).toBeGreaterThan(0)
    expect(loadPoiSearchConfig(HIKING).map((e) => e.poiType)).toContain("water")
  })

  it("falls back to the activity default on a device that no longer exists", () => {
    store.setItem("waypointer.settings", JSON.stringify({ device: { [HIKING]: "garmin_someday" } }))
    expect(loadSettings(HIKING).device).toBe("generic")
  })
})
