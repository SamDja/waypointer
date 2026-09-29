import { useEffect, useState, useSyncExternalStore } from "react"

/**
 * The visitor's colour theme. "auto" follows the system's light/dark
 * setting, live. index.html carries a copy of `applyTheme`'s rule so the
 * right theme is on before the first paint - keep the two in step.
 */
export type ThemePreference = "light" | "dark" | "auto"

// What is actually showing, once "auto" has been resolved - the map's
// cartography has one style per theme (see lib/mapStyles.ts).
export type MapTheme = "light" | "dark"

export const THEME_ORDER: readonly ThemePreference[] = ["light", "dark", "auto"]

// A display preference, so a sibling key rather than part of the
// per-activity settings in lib/settings.ts.
export const THEME_STORAGE_KEY = "waypointer.theme"

const DARK_QUERY = "(prefers-color-scheme: dark)"

export function nextTheme(pref: ThemePreference): ThemePreference {
  return THEME_ORDER[(THEME_ORDER.indexOf(pref) + 1) % THEME_ORDER.length]
}

export function loadThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    return THEME_ORDER.includes(raw as ThemePreference) ? (raw as ThemePreference) : "auto"
  } catch {
    return "auto"
  }
}

export function saveThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref)
  } catch {
    // Not remembering a preference is harmless.
  }
}

export function applyTheme(pref: ThemePreference): void {
  const dark = pref === "dark" || (pref === "auto" && window.matchMedia(DARK_QUERY).matches)
  document.documentElement.classList.toggle("dark", dark)
}

/** The current preference, and a function stepping it to the next one. */
export function useTheme(): [ThemePreference, () => void] {
  const [pref, setPref] = useState(loadThemePreference)

  useEffect(() => {
    applyTheme(pref)
    if (pref !== "auto") return
    const query = window.matchMedia(DARK_QUERY)
    const onChange = () => applyTheme("auto")
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [pref])

  const cycle = () => {
    const next = nextTheme(pref)
    saveThemePreference(next)
    setPref(next)
  }

  return [pref, cycle]
}

function subscribeToAppliedTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
}

/**
 * The theme `applyTheme` last put on the page, "auto" already resolved.
 * Read from `<html>` itself rather than from `useTheme`'s state, so the map
 * and its legend follow the header's toggle (and the system, under auto)
 * without the preference being threaded down to them.
 */
export function useResolvedTheme(): MapTheme {
  return useSyncExternalStore(
    subscribeToAppliedTheme,
    () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
    () => "light",
  )
}
