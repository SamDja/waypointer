import { useSyncExternalStore } from "react"

// The distance along the route currently pointed at - by the elevation
// profile's crosshair, or by hovering the route line on the map - so each
// can show the other's position.
//
// A tiny external store rather than App state: it changes on every pointer
// move, and routing that through App would re-render the whole tree (map
// markers included) many times a second. Only the two views that draw it
// subscribe.

let hoveredDistanceM: number | null = null
const listeners = new Set<() => void>()

export function setHoveredDistanceM(distanceM: number | null): void {
  if (distanceM === hoveredDistanceM) return
  hoveredDistanceM = distanceM
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useHoveredDistanceM(): number | null {
  return useSyncExternalStore(subscribe, () => hoveredDistanceM)
}
