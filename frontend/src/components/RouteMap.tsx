import { useEffect, useRef, useState } from "react"
import { Layer, Map, Marker, Popup, Source, useMap, type MapRef } from "react-map-gl/maplibre"
import "maplibre-gl/dist/maplibre-gl.css"
import type {
  Map as MapLibreMap,
  MapLayerMouseEvent,
  MapLayerTouchEvent,
  MapMouseEvent,
  MapTouchEvent,
  PointLike,
} from "maplibre-gl"
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crosshair,
  Locate,
  MapPin,
  Navigation,
  Play,
  Plus,
  Minus,
  Square,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { MapLegend } from "@/components/MapLegend"
import { PoiTypeCombobox } from "@/components/PoiTypeCombobox"
import { projectOntoPolylineM } from "@/lib/geometry"
import { CircleMarkerIcon, ROUTE_END_COLOR, ROUTE_START_COLOR, UserLocationMarker } from "@/lib/mapIcons"
import { MAP_STYLES } from "@/lib/mapStyles"
import { POI_TYPES } from "@/lib/poiTypes"
import { toast } from "@/lib/toast"
import type { Candidate, ExistingWaypoint, HoveredPoi } from "@/types/candidate"
import colors from "tailwindcss/colors"

export interface RouteMapProps {
  routeCoords: [number, number][]
  candidates: Candidate[]
  selectedIds: Set<number>
  onToggle: (osmId: number) => void
  existingWaypoints?: ExistingWaypoint[]
  keptWaypointIndices?: Set<number>
  onToggleExistingWaypoint?: (index: number) => void
  onChangeWaypointType?: (index: number, poiType: string) => void
  hoveredPoi?: HoveredPoi
  mapStyleKey: string
  onMapStyleChange: (key: string) => void
  planning?: PlanningProps
}

export interface PlanningProps {
  // The anchors the visitor placed, in route order - index-aligned with
  // routePlanner.plannerAnchors(), which is what onMoveAnchor's index means.
  anchors: [number, number][]
  // Straight-line stand-ins for legs whose routed geometry is still in
  // flight, rendered dashed so an in-progress leg reads as provisional.
  pendingLegs: [number, number][][]
  onAppendAnchor: (point: [number, number]) => void
  onMoveAnchor: (anchorIndex: number, point: [number, number]) => void
  // The route's ends. What this does depends on what the end is attached to:
  // next to a routed leg it moves, next to imported geometry it extends, or
  // trims when dropped back onto the route (see App.tsx).
  // droppedOnRoute is a screen-space hit test against the route line at the
  // drop position - it's what distinguishes "trim to here" from "start
  // somewhere new" (see isOnRouteLine).
  onMoveEndpoint: (which: "start" | "end", point: [number, number], droppedOnRoute: boolean) => void
  // grabDistanceM says which stretch to split (where the drag started);
  // dropPoint is where the new point lands.
  onInsertAnchor: (grabDistanceM: number, dropPoint: [number, number]) => void
}

const DEFAULT_CENTER: [number, number] = [46.06352, 11.12864]
const DEFAULT_ZOOM = 14
const EXISTING_WAYPOINT_COLOR = colors.pink[500]
const DIMMED_OPACITY = 0.32
const MAP_TILES_DIMMED_OPACITY = 0.6
// Sits above ordinary POI markers (0) so the route start/end pins stay on
// top of them, but below HOVERED_Z_INDEX so a hovered POI marker still
// wins over the endpoints.
const ROUTE_ENDPOINT_Z_INDEX = 500
const HOVERED_Z_INDEX = 1000

const ROUTE_SOURCE_ID = "route"
const ARROW_IMAGE_ID = "route-arrow"
// MapLibre's loadImage() rejects the raw SVG (fails to decode) - a
// pre-rasterized PNG works reliably. Rasterized at 2x (48px) for crispness,
// rendered at icon-size 0.5 below to display at the original 24px scale.
const ARROW_ICON_URL = "/arrow-big.png"

// Tailwind v4's palette (tailwindcss/colors) returns oklch() strings, which
// MapLibre's style validator rejects for paint properties (unlike plain
// CSS, which resolves oklch() natively). Hardcoded sRGB hex equivalent of
// colors.violet[600] - Tailwind v4's palette values were chosen to match
// v3's sRGB colors when converted to OKLCH, so this is the same color.
const ROUTE_LINE_COLOR = "#7c3aed"

// Whether a screen point lands on the route's (invisible, wider) hit layer.
// The layer only exists while planning a route that already has geometry,
// and querying a missing layer both throws and logs, so it's checked first.
//
// Deliberately a screen-space test rather than a distance in metres: this is
// what decides whether dropping an endpoint means "end the route here"
// (trim) or "start somewhere new" (extend), and a metre threshold would be
// a couple of pixels wide when zoomed out and a huge target when zoomed in.
// The hit layer is also exactly what the grab cursor highlights, so the
// gesture matches what the visitor sees.
function isOnRouteLine(map: MapLibreMap, point: PointLike): boolean {
  if (!map.getLayer(ROUTE_HIT_LAYER_ID)) return false
  return map.queryRenderedFeatures(point, { layers: [ROUTE_HIT_LAYER_ID] }).length > 0
}

// Every coordinate in this codebase is [lat, lon] - GeoJSON/MapLibre
// expect [lng, lat].
function toLngLat([lat, lon]: [number, number]): [number, number] {
  return [lon, lat]
}

function toRouteLineGeoJson(routeCoords: [number, number][]) {
  return {
    type: "Feature" as const,
    properties: {},
    geometry: {
      type: "LineString" as const,
      coordinates: routeCoords.map(toLngLat),
    },
  }
}

function getRouteBounds(
  routeCoords: [number, number][],
  candidates: Candidate[],
  existingWaypoints: ExistingWaypoint[]
): [[number, number], [number, number]] | null {
  if (routeCoords.length === 0) return null
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  const extend = (lng: number, lat: number) => {
    minLng = Math.min(minLng, lng)
    minLat = Math.min(minLat, lat)
    maxLng = Math.max(maxLng, lng)
    maxLat = Math.max(maxLat, lat)
  }
  for (const [lat, lon] of routeCoords) extend(lon, lat)
  for (const candidate of candidates) extend(candidate.lon, candidate.lat)
  for (const waypoint of existingWaypoints) extend(waypoint.lon, waypoint.lat)
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ]
}

function FitBounds({
  routeCoords,
  candidates,
  existingWaypoints,
  disabled,
}: {
  routeCoords: [number, number][]
  candidates: Candidate[]
  existingWaypoints: ExistingWaypoint[]
  // Suppressed while the route planner is active: routeCoords changes on
  // every anchor placed or dragged, and refitting on each one yanks the
  // viewport out from under the visitor mid-edit.
  disabled?: boolean
}) {
  const { current: map } = useMap()

  useEffect(() => {
    if (!map || disabled) return
    const bounds = getRouteBounds(routeCoords, candidates, existingWaypoints)
    if (!bounds) return
    map.fitBounds(bounds, { padding: 20, duration: 0 })
  }, [map, routeCoords, candidates, existingWaypoints, disabled])

  return null
}

// Crosshair while planning, so the map reads as "click to place a point"
// rather than "drag to pan". Restores the default on exit and on unmount.
function PlanningCursor({ active }: { active: boolean }) {
  const { current: map } = useMap()

  useEffect(() => {
    if (!map) return
    const canvas = map.getCanvas()
    const previous = canvas.style.cursor
    canvas.style.cursor = active ? "crosshair" : previous
    return () => {
      canvas.style.cursor = ""
    }
  }, [map, active])

  return null
}

function BearingSync({ onBearingChange }: { onBearingChange: (bearing: number) => void }) {
  const { current: map } = useMap()

  useEffect(() => {
    if (!map) return
    const handleRotate = () => onBearingChange(map.getBearing())
    map.on("rotate", handleRotate)
    return () => {
      map.off("rotate", handleRotate)
    }
  }, [map, onBearingChange])

  return null
}

// Re-registers the direction-arrow icon whenever it's missing - both on
// first load and after every mapStyle switch, since swapping styles wipes
// custom images. The cheap hasImage() check makes this a no-op for the
// (much more frequent) styledata events that aren't a style swap. Renders
// its own symbol layer (rather than always rendering one that references
// the image by id) so the layer only mounts once the image is actually
// registered - referencing a not-yet-loaded image logs a MapLibre warning
// and silently fails to render.
function RouteDirectionArrows({ routeCoords }: { routeCoords: [number, number][] }) {
  const { current: map } = useMap()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!map) return
    let cancelled = false

    async function ensureArrowImage() {
      if (!map || cancelled) return
      if (map.hasImage(ARROW_IMAGE_ID)) {
        setReady(true)
        return
      }
      setReady(false)
      try {
        const response = await map.loadImage(ARROW_ICON_URL)
        if (cancelled) return
        if (!map.hasImage(ARROW_IMAGE_ID)) {
          map.addImage(ARROW_IMAGE_ID, response.data)
        }
        setReady(true)
      } catch {
        // Style wasn't ready yet for addImage - the next styledata event
        // (there are many during a style load) will retry.
      }
    }

    ensureArrowImage()
    map.on("styledata", ensureArrowImage)
    return () => {
      cancelled = true
      map.off("styledata", ensureArrowImage)
    }
  }, [map])

  if (!ready || routeCoords.length < 2) return null

  return (
    <Layer
      id="route-direction-arrows"
      type="symbol"
      source={ROUTE_SOURCE_ID}
      layout={{
        "symbol-placement": "line",
        "symbol-spacing": 200,
        "icon-image": ARROW_IMAGE_ID,
        "icon-size": 0.5,
        // The source icon points "up" (north); MapLibre's line-placement
        // auto-rotation apparently treats that as already 90° off from the
        // line's forward direction - offset it back.
        "icon-rotate": 90,
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      }}
    />
  )
}

// OpenFreeMap's styles are vector, so there's no single raster-opacity
// paint property to fade the whole basemap - dim the map's own canvas
// element directly instead, which covers exactly the basemap (markers,
// popups, and the route line/arrows are separate DOM/layers on top of it).
function MapHoverDim({ dimmed }: { dimmed: boolean }) {
  const { current: map } = useMap()

  useEffect(() => {
    if (!map) return
    map.getCanvas().style.transition = "opacity 150ms ease-out"
  }, [map])

  useEffect(() => {
    if (!map) return
    map.getCanvas().style.opacity = dimmed ? String(MAP_TILES_DIMMED_OPACITY) : "1"
  }, [map, dimmed])

  return null
}

function EndpointMarker({
  point,
  icon,
  color,
  label,
  tooltip,
  onDragEnd,
}: {
  point: [number, number]
  icon: typeof Play
  color: string
  label: string
  tooltip: string
  onDragEnd?: (point: [number, number], droppedOnRoute: boolean) => void
}) {
  const { current: mapRef } = useMap()
  return (
    <Marker
      longitude={point[1]}
      latitude={point[0]}
      draggable={onDragEnd !== undefined}
      style={{ zIndex: ROUTE_ENDPOINT_Z_INDEX }}
      onDragEnd={
        onDragEnd
          ? (e) => {
              // The drag event carries only a lngLat, so project it back to
              // screen space for the hit test against the route line.
              const map = mapRef?.getMap()
              const onRoute = map ? isOnRouteLine(map, map.project(e.lngLat)) : false
              onDragEnd([e.lngLat.lat, e.lngLat.lng], onRoute)
            }
          : undefined
      }
      onClick={(e) => e.originalEvent.stopPropagation()}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <div aria-label={label} className={onDragEnd ? "cursor-grab active:cursor-grabbing" : undefined}>
            <CircleMarkerIcon icon={icon} bgColor={color} />
          </div>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </Marker>
  )
}

/**
 * The route's start and end. While planning these are also the drag handles
 * for both ends - there is deliberately no separate anchor dot or trim
 * handle stacked on top of them.
 *
 * A loop route normally collapses both into one marker, but not while
 * planning: two coincident ends still have to be independently grabbable.
 */
function RouteEndpointMarkers({
  routeCoords,
  onMoveEndpoint,
}: {
  routeCoords: [number, number][]
  onMoveEndpoint?: (which: "start" | "end", point: [number, number], droppedOnRoute: boolean) => void
}) {
  if (routeCoords.length === 0) return null
  const start = routeCoords[0]
  const end = routeCoords[routeCoords.length - 1]
  const isLoop = start[0] === end[0] && start[1] === end[1]
  const dragTooltip = " - drag to move, or onto the route to trim"

  if (isLoop && !onMoveEndpoint) {
    return (
      <EndpointMarker
        point={start}
        icon={Play}
        color={ROUTE_START_COLOR}
        label="Route start and end"
        tooltip="Start / End"
      />
    )
  }

  return (
    <>
      <EndpointMarker
        point={start}
        icon={Play}
        color={ROUTE_START_COLOR}
        label="Route start"
        tooltip={onMoveEndpoint ? `Start${dragTooltip}` : "Start"}
        onDragEnd={onMoveEndpoint ? (point, onRoute) => onMoveEndpoint("start", point, onRoute) : undefined}
      />
      <EndpointMarker
        point={end}
        icon={Square}
        color={ROUTE_END_COLOR}
        label="Route end"
        tooltip={onMoveEndpoint ? `End${dragTooltip}` : "End"}
        onDragEnd={onMoveEndpoint ? (point, onRoute) => onMoveEndpoint("end", point, onRoute) : undefined}
      />
    </>
  )
}

// Distinguishes a click (reset to north) from a drag (rotate) by total
// pointer travel - anything below this is treated as a click.
const DRAG_THRESHOLD_PX = 3

function CompassControl({ bearing, mapRef }: { bearing: number; mapRef: React.RefObject<MapRef | null> }) {
  const dragState = useRef<{ startX: number; startY: number; moved: boolean } | null>(null)

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    dragState.current = { startX: e.clientX, startY: e.clientY, moved: false }

    const button = e.currentTarget
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const map = mapRef.current?.getMap()
      const state = dragState.current
      if (!map || !state) return
      const dx = moveEvent.clientX - state.startX
      const dy = moveEvent.clientY - state.startY
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) state.moved = true

      const rect = button.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const angle =
        (Math.atan2(moveEvent.clientX - centerX, -(moveEvent.clientY - centerY)) * 180) / Math.PI
      map.setBearing(angle)
    }

    const handlePointerUp = () => {
      const map = mapRef.current?.getMap()
      if (map && dragState.current && !dragState.current.moved) {
        map.easeTo({ bearing: 0, duration: 300 })
      }
      dragState.current = null
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          className="bg-background touch-none"
          onPointerDown={handlePointerDown}
          aria-label="Rotate map"
        >
          <Navigation style={{ transform: `rotate(${-bearing}deg)` }} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Drag to rotate, click to reset north</TooltipContent>
    </Tooltip>
  )
}

const PLANNER_ANCHOR_COLOR = "#7c3aed"
const PLANNER_PENDING_SOURCE_ID = "planner-pending"
// Above the POI markers so anchors stay grabbable while planning over a
// dense candidate cluster, but below HOVERED_Z_INDEX.
const PLANNER_ANCHOR_Z_INDEX = 700
// Big enough to carry a legible two-digit number.
const PLANNER_ANCHOR_SIZE = 22
// A transparent, much wider copy of the route line, purely as a pointer
// target - the visible 3px line is near-impossible to grab.
const ROUTE_HIT_LAYER_ID = "route-line-hit"
// Pointer travel below this is a click, not a drag - and a click on the
// route deliberately does nothing.
const INSERT_DRAG_THRESHOLD_PX = 4

function PendingLegLines({ pendingLegs }: { pendingLegs: [number, number][][] }) {
  if (pendingLegs.length === 0) return null
  return (
    <Source
      id={PLANNER_PENDING_SOURCE_ID}
      type="geojson"
      data={{
        type: "FeatureCollection",
        features: pendingLegs.map((coords) => ({
          type: "Feature" as const,
          properties: {},
          geometry: { type: "LineString" as const, coordinates: coords.map(toLngLat) },
        })),
      }}
    >
      <Layer
        id="planner-pending-line"
        type="line"
        paint={{
          "line-color": PLANNER_ANCHOR_COLOR,
          "line-width": 2,
          "line-dasharray": [2, 2],
          "line-opacity": 0.7,
        }}
      />
    </Source>
  )
}

/**
 * A route point the visitor placed, labelled with its position along the
 * route. Only interior points get one - the start and end are the green/red
 * endpoint markers, which double as their own drag handles.
 */
function PlannerAnchorMarker({ number }: { number: number }) {
  return (
    <div
      aria-label={`Route point ${number}`}
      className="flex cursor-grab items-center justify-center rounded-full border-2 border-white text-[11px] font-semibold leading-none text-white active:cursor-grabbing"
      style={{
        width: PLANNER_ANCHOR_SIZE,
        height: PLANNER_ANCHOR_SIZE,
        backgroundColor: PLANNER_ANCHOR_COLOR,
        boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
      }}
    >
      {number}
    </div>
  )
}

/**
 * Drag anywhere on the route line to insert a point there.
 *
 * The line is a GeoJSON layer rather than a DOM marker, so this is wired up
 * imperatively via useMap(), following the same pattern as FitBounds and
 * PlanningCursor above, with listener cleanup in the effect's return.
 *
 * Two things this has to get right:
 * - The visible line is 3px, far too thin to grab reliably, so events are
 *   bound to a wider fully-transparent layer stacked on the same source.
 * - The insert position comes from where the pointer went DOWN (that's the
 *   stretch being split), while the new point lands where it came UP.
 */
function RouteLineInsertHandle({
  routeCoords,
  onInsertAnchor,
}: {
  routeCoords: [number, number][]
  onInsertAnchor: (grabDistanceM: number, dropPoint: [number, number]) => void
}) {
  const { current: map } = useMap()
  const [ghost, setGhost] = useState<[number, number] | null>(null)
  // Read by listeners that are registered once, so it can't be state.
  const drag = useRef<{ grabDistanceM: number; startX: number; startY: number; moved: boolean } | null>(null)
  const coordsRef = useRef(routeCoords)
  coordsRef.current = routeCoords

  useEffect(() => {
    if (!map) return
    // dragPan is a handler object, not a method, so it isn't proxied by
    // react-map-gl's MapRef - this needs the underlying maplibre Map.
    const raw = map.getMap()

    const handleDown = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
      const coords = coordsRef.current
      if (coords.length < 2) return
      const { distanceFromStartM } = projectOntoPolylineM([e.lngLat.lat, e.lngLat.lng], coords)
      drag.current = { grabDistanceM: distanceFromStartM, startX: e.point.x, startY: e.point.y, moved: false }
      // Otherwise the map pans out from under the gesture.
      raw.dragPan.disable()
      e.preventDefault()
    }

    const handleMove = (e: MapMouseEvent | MapTouchEvent) => {
      if (!drag.current) return
      if (Math.hypot(e.point.x - drag.current.startX, e.point.y - drag.current.startY) > INSERT_DRAG_THRESHOLD_PX) {
        drag.current.moved = true
      }
      if (drag.current.moved) setGhost([e.lngLat.lat, e.lngLat.lng])
    }

    const handleUp = (e: MapMouseEvent | MapTouchEvent) => {
      const state = drag.current
      drag.current = null
      setGhost(null)
      raw.dragPan.enable()
      if (!state) return
      // A plain click on the route does nothing - only a real drag inserts.
      if (!state.moved) return
      onInsertAnchor(state.grabDistanceM, [e.lngLat.lat, e.lngLat.lng])
    }

    const enter = () => {
      if (!drag.current) map.getCanvas().style.cursor = "grab"
    }
    const leave = () => {
      if (!drag.current) map.getCanvas().style.cursor = "crosshair"
    }

    map.on("mousedown", ROUTE_HIT_LAYER_ID, handleDown)
    map.on("touchstart", ROUTE_HIT_LAYER_ID, handleDown)
    map.on("mouseenter", ROUTE_HIT_LAYER_ID, enter)
    map.on("mouseleave", ROUTE_HIT_LAYER_ID, leave)
    map.on("mousemove", handleMove)
    map.on("touchmove", handleMove)
    map.on("mouseup", handleUp)
    map.on("touchend", handleUp)

    return () => {
      map.off("mousedown", ROUTE_HIT_LAYER_ID, handleDown)
      map.off("touchstart", ROUTE_HIT_LAYER_ID, handleDown)
      map.off("mouseenter", ROUTE_HIT_LAYER_ID, enter)
      map.off("mouseleave", ROUTE_HIT_LAYER_ID, leave)
      map.off("mousemove", handleMove)
      map.off("touchmove", handleMove)
      map.off("mouseup", handleUp)
      map.off("touchend", handleUp)
      // The gesture may be interrupted mid-drag by unmount or a mode change.
      raw.dragPan.enable()
    }
  }, [map, onInsertAnchor])

  if (!ghost) return null
  return (
    <Marker longitude={ghost[1]} latitude={ghost[0]} style={{ zIndex: PLANNER_ANCHOR_Z_INDEX }}>
      <div
        className="rounded-full border-2 border-white opacity-80"
        style={{
          width: PLANNER_ANCHOR_SIZE,
          height: PLANNER_ANCHOR_SIZE,
          backgroundColor: PLANNER_ANCHOR_COLOR,
          boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
        }}
      />
    </Marker>
  )
}

function PoiTypeLabel({ name, label }: { name: string | null; label: string | undefined }) {
  if (name) {
    return <p className="text-muted-foreground">{label ?? "Point of interest"}</p>
  }
  return null
}

export function RouteMap({
  routeCoords,
  candidates,
  selectedIds,
  onToggle,
  existingWaypoints = [],
  keptWaypointIndices = new Set(),
  onToggleExistingWaypoint,
  onChangeWaypointType,
  hoveredPoi = null,
  mapStyleKey,
  onMapStyleChange,
  planning,
}: RouteMapProps) {
  const [openPopup, setOpenPopup] = useState<{ kind: "candidate" | "waypoint"; id: number } | null>(null)
  const [bearing, setBearing] = useState(0)
  const [locating, setLocating] = useState(false)
  // [lon, lat] - unlike the rest of this file's [lat, lon] convention, this
  // is stored ready for direct use as a <Marker>'s longitude/latitude props.
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null)
  const mapRef = useRef<MapRef>(null)
  const hasRoute = routeCoords.length > 0
  const center = hasRoute ? routeCoords[0] : DEFAULT_CENTER
  const zoom = hasRoute ? 13 : DEFAULT_ZOOM
  const isHovering = hoveredPoi !== null
  const styleUrl = MAP_STYLES.find((s) => s.key === mapStyleKey)?.styleUrl ?? MAP_STYLES[0].styleUrl

  const pan = (dx: number, dy: number) => {
    mapRef.current?.getMap().panBy([dx, dy], { duration: 200 })
  }

  const handleCenterOnRoute = () => {
    const map = mapRef.current?.getMap()
    const bounds = getRouteBounds(routeCoords, candidates, existingWaypoints)
    if (!map || !bounds) return
    map.fitBounds(bounds, { padding: 20, duration: 500 })
  }

  const handleCenterOnLocation = () => {
    const map = mapRef.current?.getMap()
    if (!map) return
    if (!navigator.geolocation) {
      toast("Geolocation is not supported by your browser", "error")
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location: [number, number] = [position.coords.longitude, position.coords.latitude]
        map.flyTo({ center: location, zoom: 15, duration: 800 })
        setUserLocation(location)
        setLocating(false)
      },
      (error) => {
        toast(
          error.code === error.PERMISSION_DENIED ? "Location permission denied" : "Couldn't get your location",
          "error"
        )
        setLocating(false)
      },
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  return (
    <TooltipProvider>
      <div className="relative h-full w-full">
        <Map
          ref={mapRef}
          initialViewState={{ longitude: center[1], latitude: center[0], zoom }}
          mapStyle={styleUrl}
          style={{ width: "100%", height: "100%" }}
          onClick={
            planning
              ? (e) => {
                  // Clicking the route itself does nothing - that gesture is
                  // reserved for dragging a new point out of the line, and
                  // appending to the far end is never what a click on the
                  // middle of the route meant.
                  if (isOnRouteLine(e.target, e.point)) return
                  planning.onAppendAnchor([e.lngLat.lat, e.lngLat.lng])
                }
              : undefined
          }
        >
          <MapHoverDim dimmed={isHovering} />
          <BearingSync onBearingChange={setBearing} />
          <PlanningCursor active={planning !== undefined} />

          {hasRoute && (
            <Source id={ROUTE_SOURCE_ID} type="geojson" data={toRouteLineGeoJson(routeCoords)}>
              <Layer id="route-line" type="line" paint={{ "line-color": ROUTE_LINE_COLOR, "line-width": 3 }} />
              {planning && (
                <Layer
                  id={ROUTE_HIT_LAYER_ID}
                  type="line"
                  paint={{ "line-color": ROUTE_LINE_COLOR, "line-width": 16, "line-opacity": 0 }}
                />
              )}
            </Source>
          )}
          <RouteDirectionArrows routeCoords={routeCoords} />

          {candidates.map((candidate) => {
            const isSelected = selectedIds.has(candidate.osm_id)
            const isHovered = hoveredPoi?.kind === "candidate" && hoveredPoi.id === candidate.osm_id
            const checkboxId = `map-candidate-${candidate.osm_id}`
            const poiType = POI_TYPES.find((p) => p.key === candidate.poi_type)
            const Icon = poiType?.icon ?? POI_TYPES[0].icon
            const color = poiType?.color ?? POI_TYPES[0].color
            return (
              <Marker
                key={candidate.osm_id}
                longitude={candidate.lon}
                latitude={candidate.lat}
                style={{ zIndex: isHovered ? HOVERED_Z_INDEX : 0 }}
                onClick={(e) => {
                  // Without this, the click bubbles to the map's own click
                  // handler in the same tick, which the new Popup's
                  // closeOnClick listener picks up and immediately closes
                  // the popup that was just opened.
                  e.originalEvent.stopPropagation()
                  setOpenPopup({ kind: "candidate", id: candidate.osm_id })
                }}
              >
                <CircleMarkerIcon
                  icon={Icon}
                  iconColor={isSelected ? colors.olive[50] : colors.mist[400]}
                  bgColor={isSelected ? color : colors.mist[200]}
                  highlighted={isHovered}
                  opacity={isHovered ? 1 : isHovering ? DIMMED_OPACITY : 1}
                />
                {openPopup?.kind === "candidate" && openPopup.id === candidate.osm_id && (
                  <Popup
                    longitude={candidate.lon}
                    latitude={candidate.lat}
                    anchor="bottom"
                    offset={16}
                    onClose={() => setOpenPopup(null)}
                  >
                    <div className="flex flex-col gap-2 text-sm">
                      <div className="flex items-center gap-1 font-medium">
                        <Icon className="size-4" style={{ color }} />
                        {candidate.name || (poiType?.label ?? "Point of interest")}
                      </div>
                      <PoiTypeLabel name={candidate.name} label={poiType?.label}></PoiTypeLabel>
                      <p className="text-muted-foreground">{candidate.distance_m.toFixed(0)}m from route</p>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={checkboxId}
                          checked={isSelected}
                          onCheckedChange={() => onToggle(candidate.osm_id)}
                        />
                        <Label htmlFor={checkboxId} className="font-normal">
                          Include
                        </Label>
                      </div>
                    </div>
                  </Popup>
                )}
              </Marker>
            )
          })}

          {existingWaypoints.map((waypoint) => {
            const isKept = keptWaypointIndices.has(waypoint.index)
            const isHovered = hoveredPoi?.kind === "waypoint" && hoveredPoi.id === waypoint.index
            const checkboxId = `map-existing-waypoint-${waypoint.index}`
            const poiType = POI_TYPES.find((p) => p.key === waypoint.poi_type)
            const Icon = poiType?.icon ?? MapPin
            const color = poiType?.color ?? EXISTING_WAYPOINT_COLOR
            return (
              <Marker
                key={waypoint.index}
                longitude={waypoint.lon}
                latitude={waypoint.lat}
                style={{ zIndex: isHovered ? HOVERED_Z_INDEX : 0 }}
                onClick={(e) => {
                  e.originalEvent.stopPropagation()
                  setOpenPopup({ kind: "waypoint", id: waypoint.index })
                }}
              >
                <CircleMarkerIcon
                  icon={Icon}
                  iconColor={isKept ? colors.olive[50] : colors.mist[400]}
                  bgColor={isKept ? color : colors.mist[200]}
                  highlighted={isHovered}
                  opacity={isHovered ? 1 : isHovering ? DIMMED_OPACITY : 1}
                />
                {openPopup?.kind === "waypoint" && openPopup.id === waypoint.index && (
                  <Popup
                    longitude={waypoint.lon}
                    latitude={waypoint.lat}
                    anchor="bottom"
                    offset={16}
                    onClose={() => setOpenPopup(null)}
                  >
                    <div className="flex flex-col gap-2 text-sm">
                      <div className="flex items-center gap-1 font-medium">
                        <Icon className="size-4" style={{ color }} />
                        {waypoint.name || "(unnamed)"}
                      </div>
                      <p className="text-muted-foreground">Already in this file</p>
                      {onChangeWaypointType && (
                        <PoiTypeCombobox
                          value={waypoint.poi_type}
                          onChange={(poiType) => onChangeWaypointType(waypoint.index, poiType)}
                        />
                      )}
                      {onToggleExistingWaypoint && (
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={checkboxId}
                            checked={isKept}
                            onCheckedChange={() => onToggleExistingWaypoint(waypoint.index)}
                          />
                          <Label htmlFor={checkboxId} className="font-normal">
                            Keep
                          </Label>
                        </div>
                      )}
                    </div>
                  </Popup>
                )}
              </Marker>
            )
          })}

          {planning && (
            <>
              <PendingLegLines pendingLegs={planning.pendingLegs} />
              {/* Interior points only - anchor 0 and the last one are the
                  start/end markers below, which are their own drag handles.
                  The anchor index doubles as the displayed number, so points
                  read 1, 2, 3 in the order they're ridden. */}
              {planning.anchors.slice(1, -1).map((anchor, i) => {
                const index = i + 1
                return (
                  <Marker
                    // Anchors are positional - a key on coordinates would make
                    // React reuse the wrong marker when one is dragged onto
                    // another's old position.
                    key={`anchor-${index}`}
                    longitude={anchor[1]}
                    latitude={anchor[0]}
                    draggable
                    style={{ zIndex: PLANNER_ANCHOR_Z_INDEX }}
                    onDragEnd={(e) => planning.onMoveAnchor(index, [e.lngLat.lat, e.lngLat.lng])}
                    onClick={(e) => e.originalEvent.stopPropagation()}
                  >
                    <PlannerAnchorMarker number={index} />
                  </Marker>
                )
              })}
              <RouteLineInsertHandle routeCoords={routeCoords} onInsertAnchor={planning.onInsertAnchor} />
            </>
          )}

          <RouteEndpointMarkers
            routeCoords={routeCoords}
            onMoveEndpoint={planning?.onMoveEndpoint}
          />
          {userLocation && (
            <Marker longitude={userLocation[0]} latitude={userLocation[1]}>
              <UserLocationMarker />
            </Marker>
          )}
          <FitBounds
            routeCoords={routeCoords}
            candidates={candidates}
            existingWaypoints={existingWaypoints}
            disabled={planning !== undefined}
          />
        </Map>

        <div className="absolute left-2 top-2 z-10">
          <MapLegend candidates={candidates} existingWaypoints={existingWaypoints} mapStyleKey={mapStyleKey} />
        </div>

        <div className="absolute right-2 top-2 z-10">
          <Select value={mapStyleKey} onValueChange={onMapStyleChange}>
            <SelectTrigger className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MAP_STYLES.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="absolute bottom-2 right-2 z-10 flex flex-col items-end gap-2">
          <div className="grid grid-cols-3 grid-rows-3 gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="bg-background col-start-2 row-start-1"
                  onClick={() => pan(0, -100)}
                  aria-label="Pan up"
                >
                  <ChevronUp />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Pan up</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="bg-background col-start-1 row-start-2"
                  onClick={() => pan(-100, 0)}
                  aria-label="Pan left"
                >
                  <ChevronLeft />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Pan left</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="bg-background col-start-3 row-start-2"
                  onClick={() => pan(100, 0)}
                  aria-label="Pan right"
                >
                  <ChevronRight />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Pan right</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="bg-background col-start-2 row-start-3"
                  onClick={() => pan(0, 100)}
                  aria-label="Pan down"
                >
                  <ChevronDown />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Pan down</TooltipContent>
            </Tooltip>
          </div>

          <div className="flex flex-col gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="bg-background"
                  onClick={() => mapRef.current?.getMap().zoomIn({ duration: 200 })}
                  aria-label="Zoom in"
                >
                  <Plus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom in</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="bg-background"
                  onClick={() => mapRef.current?.getMap().zoomOut({ duration: 200 })}
                  aria-label="Zoom out"
                >
                  <Minus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom out</TooltipContent>
            </Tooltip>
            <CompassControl bearing={bearing} mapRef={mapRef} />
          </div>
        </div>

        <div className="absolute bottom-2 left-2 z-10 flex gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                className="bg-background"
                onClick={handleCenterOnRoute}
                disabled={!hasRoute}
                aria-label="Center on route"
              >
                <Crosshair />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Center on route</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                className="bg-background"
                loading={locating}
                onClick={handleCenterOnLocation}
                aria-label="Center on my location"
              >
                <Locate />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Center on my location</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  )
}
