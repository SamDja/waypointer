import { renderToStaticMarkup } from "react-dom/server"
import L from "leaflet"
import type { LucideIcon } from "lucide-react"

export const ROUTE_START_COLOR = "oklch(53.2% 0.157 131.589)"
export const ROUTE_END_COLOR = "oklch(50.5% 0.213 27.518)"

interface CircleDivIconOptions {
  icon: LucideIcon
  color: string
  size?: number
  opacity?: number
}

export function buildCircleDivIcon({ icon: Icon, color, size = 28, opacity = 1 }: CircleDivIconOptions): L.DivIcon {
  const iconSize = Math.round(size * 0.55)
  const iconSvg = renderToStaticMarkup(<Icon size={iconSize} color="#fff" fill="#fff" strokeWidth={2.5} />)
  const html = `
    <div style="
      width: ${size}px;
      height: ${size}px;
      border-radius: 100%;
      background-color: ${color};
      opacity: ${opacity};
      box-shadow: 0 1px 3px rgba(0,0,0,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
    ">${iconSvg}</div>
  `
  return L.divIcon({
    html,
    // Leaflet's own leaflet.css styles .leaflet-div-icon with a white
    // background + gray border - override with an empty className or that
    // shows through behind our circle.
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  })
}
