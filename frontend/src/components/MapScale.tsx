import { useEffect, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { useMap } from "react-map-gl/maplibre"

import { scaleBar, type ScaleBar } from "@/lib/mapScale"

// The longest the bar may grow; it shrinks to the nearest round distance.
const MAX_WIDTH_PX = 96

interface ScaleState {
  host: HTMLDivElement
  zoom: number
  bar: ScaleBar | null
}

/**
 * The current zoom level and a scale bar, so what the map shows at this
 * zoom can be read in real distances.
 *
 * Rendered inside the <Map> (it needs useMap) but portalled into a host in
 * RouteMap's control group, which sits outside the map's isolated stacking
 * context - the same arrangement as DetachedAttribution. Its state lives
 * here rather than in RouteMap, since it changes on every frame of a pan.
 */
export function MapScale({ hostRef }: { hostRef: RefObject<HTMLDivElement | null> }) {
  const { current: mapRef } = useMap()
  const [state, setState] = useState<ScaleState | null>(null)

  useEffect(() => {
    const map = mapRef?.getMap()
    const host = hostRef.current
    if (!map || !host) return
    const update = () => {
      // Measured across the middle of the view: Web Mercator's scale varies
      // with latitude, and the centre is where the visitor is looking.
      const y = map.getContainer().clientHeight / 2
      const metres = map.unproject([0, y]).distanceTo(map.unproject([MAX_WIDTH_PX, y]))
      setState({ host, zoom: map.getZoom(), bar: scaleBar(metres, MAX_WIDTH_PX) })
    }
    // The first reading waits a frame, like every later one does.
    const first = requestAnimationFrame(update)
    map.on("move", update)
    map.on("resize", update)
    return () => {
      cancelAnimationFrame(first)
      map.off("move", update)
      map.off("resize", update)
    }
  }, [mapRef, hostRef])

  if (!state) return null
  return createPortal(
    <div className="flex items-center gap-2 px-2 py-1 text-xs tabular-nums text-foreground">
      {/* <span title="Zoom level">z{state.zoom.toFixed(1)}</span> */}
      {state.bar && (
        <span className="flex flex-row items-baseline gap-1" aria-label={`Scale: ${state.bar.label}`}>
          <span>{state.bar.label}</span>
          <span
            className="h-1 border-x border-b border-foreground"
            style={{ width: state.bar.widthPx }}
            aria-hidden
          />
        </span>
      )}
    </div>,
    state.host,
  )
}
