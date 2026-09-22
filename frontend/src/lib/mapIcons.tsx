import { MapPin, type LucideIcon } from "lucide-react"
import colors from "tailwindcss/colors"

interface CircleMarkerIconProps {
  icon: LucideIcon
  bgColor: string
  // A full CSS background (e.g. START_FINISH_BACKGROUND) drawn instead of
  // bgColor, which still tints the highlight glow.
  background?: string
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
  background,
  iconColor = colors.olive[50],
  size = 28,
  highlighted = false,
  opacity = 1,
}: CircleMarkerIconProps) {
  const iconSize = Math.round(size * 0.7)

  return (
    <div
      className="flex items-center justify-center rounded-full transition-opacity hover:cursor-pointer duration-150 ease-out"
      style={{
        width: size,
        height: size,
        background: background ?? bgColor,
        boxShadow: highlighted
          ? `0 1px 3px rgba(0,0,0,0.4), 0 0 0 4px color-mix(in oklch, ${bgColor} 40%, transparent)`
          : '0 1px 3px rgba(0,0,0,0.4)',
        opacity,
      }}
    >
      <Icon size={iconSize} color={iconColor} strokeWidth={2} />
    </div>
  )
}

// The place search's pick: a violet pin with a see-through dot. Lucide's
// MapPin is a teardrop <path> with a <circle> drawn over it, and `fill`
// paints both - so the dot is cut out of the teardrop with a mask (lucide
// icons render `children` inside their <svg>), and the circle keeps only its
// white outline. Only one pin is ever shown, so a fixed mask id is safe.
// Its tip is the place, so the Marker holding it needs anchor="bottom" (plus
// SEARCHED_PLACE_PIN_TIP_GAP_PX in RouteMap: the tip sits a little above the
// bottom of lucide's 24px box).
export function SearchedPlacePin() {
  return (
    <MapPin
      size={30}
      strokeWidth={1.2}
      color={colors.white}
      fill={colors.violet[600]}
      className="block cursor-pointer drop-shadow-md [&>circle]:fill-none [&>path]:[mask:url(#searched-place-pin-hole)]"
      aria-label="Searched place"
    >
      <mask id="searched-place-pin-hole" maskUnits="userSpaceOnUse" x={0} y={0} width={24} height={24}>
        <rect width={24} height={24} fill="white" />
        <circle cx={12} cy={10} r={3} fill="black" />
      </mask>
    </MapPin>
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
