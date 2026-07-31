import type { LucideIcon } from "lucide-react"
import colors from "tailwindcss/colors"

export const ROUTE_START_COLOR = "oklch(53.2% 0.157 131.589)"
export const ROUTE_END_COLOR = "oklch(50.5% 0.213 27.518)"

interface CircleMarkerIconProps {
  icon: LucideIcon
  bgColor: string
  iconColor?: string
  size?: number
  // Adds a glow ring in the marker's own bgColor around the base drop
  // shadow - see RouteMap.tsx's isHovered. This snaps rather than
  // transitions on hover - a discrete highlight toggle rather than a
  // continuous fade, which reads fine for something as instantaneous as a
  // hover.
  highlighted?: boolean
  // A real prop, unlike the old Leaflet DivIcon version - react-map-gl's
  // <Marker> keeps this component's DOM node stable across re-renders, so
  // a plain CSS transition (see the className below) animates opacity
  // changes with no special-casing needed.
  opacity?: number
}

export function CircleMarkerIcon({
  icon: Icon,
  bgColor,
  iconColor = colors.olive[50],
  size = 28,
  opacity = 1,
}: CircleMarkerIconProps) {
  const iconSize = Math.round(size * 0.7)

  return (
    <div
      className="flex items-center justify-center rounded-full transition-opacity hover:cursor-pointer duration-150 ease-out"
      style={{
        width: size,
        height: size,
        backgroundColor: bgColor,
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        opacity,
      }}
    >
      <Icon size={iconSize} color={iconColor} strokeWidth={2} />
    </div>
  )
}

const USER_LOCATION_SIZE = 14

export function UserLocationMarker() {
  return (
    <div
      className="rounded-full"
      style={{
        width: USER_LOCATION_SIZE,
        height: USER_LOCATION_SIZE,
        backgroundColor: colors.blue[500],
        border: "2px solid white",
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
      }}
    />
  )
}
