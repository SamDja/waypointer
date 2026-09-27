import { describe, expect, it } from "vitest"
import { hasStravaActivityScope, missingStravaScopeWarning } from "@/lib/stravaAuth"
import { stravaSportLabel } from "@/lib/stravaApi"

describe("stravaSportLabel", () => {
  it("splits Strava's sport types into words", () => {
    expect(stravaSportLabel("Ride")).toBe("Ride")
    expect(stravaSportLabel("GravelRide")).toBe("Gravel ride")
    expect(stravaSportLabel("TrailRun")).toBe("Trail run")
  })

  it("names the ones a mechanical split gets wrong", () => {
    expect(stravaSportLabel("EBikeRide")).toBe("E-bike ride")
    expect(stravaSportLabel("MountainBikeRide")).toBe("MTB ride")
  })

  it("falls back when Strava sends none", () => {
    expect(stravaSportLabel("")).toBe("Activity")
  })
})

describe("Strava scopes", () => {
  it("lists activities only when activity:read_all was granted", () => {
    expect(hasStravaActivityScope("read,read_all,activity:read_all")).toBe(true)
    // A connection made before activity import.
    expect(hasStravaActivityScope("read,read_all")).toBe(false)
    // Nothing recorded: try, and let Strava's answer decide.
    expect(hasStravaActivityScope(undefined)).toBe(true)
  })

  it("warns about each thing that wasn't granted", () => {
    expect(missingStravaScopeWarning("read,read_all,activity:read_all")).toBeNull()
    expect(missingStravaScopeWarning(null)).toBeNull()
    expect(missingStravaScopeWarning("read,read_all")).toContain("your activities")
    expect(missingStravaScopeWarning("read")).toContain("your private routes or your activities")
  })
})
