import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { THEME_STORAGE_KEY, loadThemePreference, nextTheme, saveThemePreference } from "@/lib/theme"

let data: Map<string, string>

beforeEach(() => {
  data = new Map()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("theme preference", () => {
  it("cycles light, dark, auto and back", () => {
    expect(nextTheme("light")).toBe("dark")
    expect(nextTheme("dark")).toBe("auto")
    expect(nextTheme("auto")).toBe("light")
  })

  it("defaults to following the system", () => {
    expect(loadThemePreference()).toBe("auto")
    data.set(THEME_STORAGE_KEY, "sepia")
    expect(loadThemePreference()).toBe("auto")
  })

  it("remembers the chosen theme", () => {
    saveThemePreference("dark")
    expect(loadThemePreference()).toBe("dark")
  })
})
