import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearLegacyConnection, loadLegacyConnections, localAvgSpeeds } from "@/lib/localData"

/**
 * What a browser kept from before accounts existed is read once, to offer
 * moving it into the account. It must only offer what was really there:
 * connections that still have a refresh token, and speeds the visitor set
 * rather than every activity's default.
 */

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

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("loadLegacyConnections", () => {
  it("reads the tokens the old app stored", () => {
    localStorage.setItem(
      "waypointer.strava",
      JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 1, athleteId: 7, athleteLabel: "Ada", scope: "read,read_all" }),
    )
    localStorage.setItem("waypointer.wahoo", JSON.stringify({ accessToken: "a", refreshToken: "w" }))
    expect(loadLegacyConnections()).toEqual([
      { provider: "strava", refreshToken: "r", scope: "read,read_all", label: "Ada" },
      { provider: "wahoo", refreshToken: "w", scope: undefined, label: undefined },
    ])
  })

  it("skips anything without a refresh token or unreadable", () => {
    localStorage.setItem("waypointer.strava", JSON.stringify({ accessToken: "a" }))
    localStorage.setItem("waypointer.wahoo", "{not json")
    expect(loadLegacyConnections()).toEqual([])
  })

  it("clears one app's tokens", () => {
    localStorage.setItem("waypointer.wahoo", JSON.stringify({ refreshToken: "w" }))
    clearLegacyConnection("wahoo")
    expect(localStorage.getItem("waypointer.wahoo")).toBeNull()
  })
})

describe("localAvgSpeeds", () => {
  it("is empty when the visitor never set a speed", () => {
    expect(localAvgSpeeds()).toEqual({})
  })

  it("only offers the speeds that were set, per activity", () => {
    localStorage.setItem("waypointer.avgSpeedKmh", JSON.stringify({ hiking: 4.5, nonsense: 10, road_cycling: -1 }))
    expect(localAvgSpeeds()).toEqual({ hiking: 4.5 })
  })

  it("adopts a bare legacy number as the default activity's", () => {
    localStorage.setItem("waypointer.avgSpeedKmh", "22")
    expect(localAvgSpeeds()).toEqual({ road_cycling: 22 })
  })
})
