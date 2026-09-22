import { useEffect, useState, type RefObject } from "react"

// How much of the full-page map is covered by the floating header (top),
// sidebar (right) and - while planning - the elevation profile (bottom), in
// pixels, so RouteMap can keep its own controls and fit-to-route framing
// clear of them.
export interface MapInsets {
  top: number
  right: number
  bottom: number
}

// Tailwind's `md` breakpoint: only from here up does the sidebar float over
// the map. Below it the sidebar stacks under the map and covers nothing.
const OVERLAY_SIDEBAR_QUERY = "(min-width: 48rem)"

export function useMapInsets(
  headerRef: RefObject<HTMLElement | null>,
  asideRef: RefObject<HTMLElement | null>
): MapInsets {
  const [insets, setInsets] = useState<MapInsets>({ top: 0, right: 0, bottom: 0 })

  useEffect(() => {
    const header = headerRef.current
    const aside = asideRef.current
    if (!header || !aside) return
    const media = window.matchMedia(OVERLAY_SIDEBAR_QUERY)
    const update = () => {
      const next = { top: header.offsetHeight, right: media.matches ? aside.offsetWidth : 0, bottom: 0 }
      setInsets((prev) => (prev.top === next.top && prev.right === next.right ? prev : next))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(header)
    observer.observe(aside)
    media.addEventListener("change", update)
    return () => {
      observer.disconnect()
      media.removeEventListener("change", update)
    }
  }, [headerRef, asideRef])

  return insets
}

/** An element's rendered height, tracked as it resizes (0 while it isn't mounted). */
export function useElementHeight(element: HTMLElement | null): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return element ? height : 0
}
