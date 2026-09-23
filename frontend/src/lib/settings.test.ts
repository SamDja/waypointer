import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  loadAvgSpeedKmh,
  loadOffRouteThresholdM,
  loadPoiSearchConfig,
  saveAvgSpeedKmh,
  saveOffRouteThresholdM,
  savePoiSearchConfig,
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
})
