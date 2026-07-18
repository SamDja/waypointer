import { renderToStaticMarkup } from "react-dom/server"
import L from "leaflet"
import type { LucideIcon } from "lucide-react"
import colors from "tailwindcss/colors"

export const ROUTE_START_COLOR = "oklch(53.2% 0.157 131.589)"
export const ROUTE_END_COLOR = "oklch(50.5% 0.213 27.518)"

interface CircleDivIconOptions {
  icon: LucideIcon
  bgColor: string
  iconColor?: string
  size?: number
  // Adds a glow ring in the marker's own bgColor around the base drop
  // shadow - see RouteMap.tsx's isHovered. Baked into the icon HTML (like
  // bgColor itself) rather than driven through a <Marker> prop, so unlike
  // opacity (see below) this snaps rather than transitions on hover - a
  // discrete highlight toggle rather than a continuous fade, which reads
  // fine for something as instantaneous as a hover.
  highlighted?: boolean
}

// Opacity is deliberately not an option here - it's driven via the
// <Marker opacity> prop instead (see RouteMap.tsx), which Leaflet applies
// as a style mutation on the marker's persistent icon element. Baking it
// into this HTML string instead would mean every opacity change replaces
// the icon's innerHTML wholesale (react-leaflet's Marker.setIcon(), since
// the icon object identity changes), leaving no previous DOM state for a
// CSS transition to animate from - it would just snap.
export function buildCircleDivIcon({
  icon: Icon,
  bgColor,
  iconColor = colors.olive[50],
  size = 28,
  highlighted = false,
}: CircleDivIconOptions): L.DivIcon {
  const iconSize = Math.round(size * 0.7)
  const iconSvg = renderToStaticMarkup(<Icon size={iconSize} color={iconColor} strokeWidth={2} />)
  const boxShadow = highlighted
    ? `0 0 4px 4px color-mix(in oklch, ${bgColor} 55%, transparent), 0 2px 6px rgba(0,0,0,0.5)`
    : "0 1px 3px rgba(0,0,0,0.4)"
  const html = `
    <div style="
      width: ${size}px;
      height: ${size}px;
      border-radius: 100%;
      background-color: ${bgColor};
      box-shadow: ${boxShadow};
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
