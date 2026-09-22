import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react"
import { Layer, Map, Marker, Popup, Source, useMap, type MapRef } from "react-map-gl/maplibre"
import "maplibre-gl/dist/maplibre-gl.css"
import type {
  Map as MapLibreMap,
  MapLayerMouseEvent,
  MapLayerTouchEvent,
  MapMouseEvent,
  MapTouchEvent,
  PaddingOptions,
  PointLike,
} from "maplibre-gl"
import { AttributionControl, setWorkerUrl } from "maplibre-gl"
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crosshair,
  Flag,
  Info,
  Locate,
  MapPin,
  Navigation,
  Play,
  Plus,
  Minus,
  Square,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { MapLegend } from "@/components/MapLegend"
import { PoiTypeCombobox } from "@/components/PoiTypeCombobox"
import { buildAddablePoiFilter, resolvePoiTypeFromFeatureProps } from "@/lib/basemapPoiMapping"
import { cumulativeDistancesM, pointAtDistanceM, projectOntoPolylineM } from "@/lib/geometry"
import { setHoveredDistanceM, useHoveredDistanceM } from "@/lib/hoverDistance"
import { PLANNER_POINT_COLOR, ROUTE_END_COLOR, ROUTE_START_COLOR, START_FINISH_BACKGROUND } from "@/lib/mapColors"
import { CircleMarkerIcon, UserLocationMarker } from "@/lib/mapIcons"
import { MAP_STYLES } from "@/lib/mapStyles"
import {
  formatExactDateTime,
  formatRelativeDate,
  groupOsmTags,
  type FormattedOsmTag,
} from "@/lib/osmTagLabels"
import { POI_TYPES } from "@/lib/poiTypes"
import { toast } from "@/lib/toast"
import { tailwindHex } from "@/lib/color"
import type { MapInsets } from "@/lib/useMapInsets"
import type { RouteShape } from "@/lib/routePlanner"
import type { Candidate, CandidateDetails, ExistingWaypoint, HoveredPoi, PoiLookupResult } from "@/types/candidate"
import colors from "tailwindcss/colors"

// maplibre-gl v6 no longer inlines its worker: it loads it as a sibling file of
// its own module URL, which Vite's dep pre-bundling (dev) and chunking (build)
// both break, leaving the map with no tiles. Point it at a Vite-bundled copy
// instead - this must run before the first <Map> mounts.
setWorkerUrl(maplibreWorkerUrl)

// A basemap POI icon the visitor clicked, mid-resolution or resolved -
// rendered as its own Popup (not tied to a Marker, since "not found" has no
// real OSM node to anchor one to). See App.tsx's handleBasemapPoiClick.
export interface PendingPoiLookup {
  lat: number
  lon: number
  poiType: string
  status: "loading" | "error" | "not_found" | "done"
  result?: PoiLookupResult
}

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
  // Tags/last-edited for every candidate with a popup, keyed by osm_id -
  // covers both search-found candidates (via FindPoisResponse.candidate_details)
  // and basemap-click-added ones (see App.tsx's candidateDetails).
  candidateDetails?: Record<number, CandidateDetails>
  // osm_ids added via a basemap click, used only to exclude those markers
  // from FitBounds - not for deciding popup content (see candidateDetails).
  clickAddedCandidateIds?: Set<number>
  onBasemapPoiClick?: (lat: number, lon: number, poiType: string) => void
  pendingLookup?: PendingPoiLookup | null
  onConfirmPendingLookup?: () => void
  onDismissPendingLookup?: () => void
  // Present exactly while the route planner is active - see PlanningProps.
  planning?: PlanningProps
  // Bumped to fit the map to the route once, even while planning (when it
  // otherwise never refits) - e.g. after restoring a saved draft.
  fitRequest?: number
  // Reported on load and after every move: the zoom, for the route planner's
  // spur tolerance (routePlanner.spurToleranceM, which depends on how zoomed
  // in a point was placed), and the centre, to bias the place search towards
  // where the visitor is looking.
  onViewChange?: (view: { zoom: number; center: [number, number] }) => void
  // Frames a place once per new `id` - fitted to its bbox if it's an area,
  // flown to otherwise (the place search's pick).
  focusRequest?: FocusRequest | null
  // How much of the map the floating header/sidebar cover. The map itself
  // stays full-page; only its own controls and fit-to-route framing move
  // clear of the covered area.
  insets?: MapInsets
}

export interface FocusRequest {
  id: number
  lat: number
  lon: number
  // [west, south, east, north]
  bbox: [number, number, number, number] | null
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
  // The clicked point (index into anchors). Clicking a point selects it,
  // which opens a popup on it offering to delete it.
  selectedAnchor: number | null
  onSelectAnchor: (anchorIndex: number) => void
  onClearSelection: () => void
  onDeleteAnchor: (anchorIndex: number) => void
  // Shared with PlannerPanel's point list: the hovered point glows on the
  // map, and hovering a marker highlights its row.
  hoveredAnchor: number | null
  onHoverAnchor: (anchorIndex: number | null) => void
  // A loop or out-and-back finishes at its start: the last anchor is then an
  // ordinary numbered point, and the start is one combined start/finish
  // marker.
  shape: RouteShape
}


// Stable empty-Set default for clickAddedCandidateIds - a fresh `new Set()`
// literal in the destructured default would change identity every render,
// defeating fitBoundsCandidates' useMemo below.
const EMPTY_ID_SET: Set<number> = new Set()
const NO_INSETS: MapInsets = { top: 0, right: 0, bottom: 0 }
// Breathing room around the route when fitting it into view, on top of
// whatever the floating header/sidebar cover.
const FIT_PADDING_PX = 20

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
// An open Popup has no z-index prop of its own - index.css's
// `.maplibregl-popup` rule keeps it above both constants above.

const ROUTE_SOURCE_ID = "route"
const ARROW_IMAGE_ID = "route-arrow"
// MapLibre's loadImage() rejects the raw SVG (fails to decode) - a
// pre-rasterized PNG works reliably. Rasterized at 2x (48px) for crispness,
// rendered at icon-size 0.5 below to display at the original 24px scale.
const ARROW_ICON_URL = "/arrow-big.png"

// Tailwind v4's palette (tailwindcss/colors) returns oklch() strings, which
// MapLibre's style validator rejects for paint properties (unlike plain
// CSS, which resolves oklch() natively) - so the violet-600 step is converted
// to sRGB hex (the same colour the browser paints for it).
const ROUTE_LINE_COLOR = tailwindHex(colors.violet[600])

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

// MapLibre's own attribution control, mounted into a host element outside the
// map instead of into one of the map's control corners. The map container is
// its own stacking context (see the <Map> below) so its markers and popups
// can never rise above the surrounding UI - which would trap a corner
// control too. This keeps MapLibre's behaviour (attributions collected from
// the style's sources, shown until the first drag, then collapsed to an "i"
// button) while letting index.css pin it to the page corner above the
// sidebar.
function DetachedAttribution({ hostRef }: { hostRef: RefObject<HTMLDivElement | null> }) {
  const { current: mapRef } = useMap()

  useEffect(() => {
    const map = mapRef?.getMap()
    const host = hostRef.current
    if (!map || !host) return
    // Passing options replaces MapLibre's defaults wholesale, so its own
    // "MapLibre" credit has to be restated.
    const control = new AttributionControl({
      compact: true,
      customAttribution: '<a href="https://maplibre.org/" target="_blank">MapLibre</a>',
    })
    host.appendChild(control.onAdd(map))
    return () => control.onRemove()
  }, [mapRef, hostRef])

  return null
}

/**
 * Fits the map to the route once per bump of `request`. The route can arrive
 * a render after the request (a restored draft's geometry is synthesized by
 * an effect), so a request waits until there's a route to fit.
 */
// How close to zoom in on a place that has no area (a village's point, a peak).
const FOCUS_POINT_ZOOM = 14

function FocusOnRequest({ request, padding }: { request: FocusRequest | null; padding: PaddingOptions }) {
  const { current: map } = useMap()
  const handledRef = useRef<number | null>(null)
  useEffect(() => {
    if (!map || !request || request.id === handledRef.current) return
    handledRef.current = request.id
    if (request.bbox) {
      const [west, south, east, north] = request.bbox
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding, duration: 800, maxZoom: FOCUS_POINT_ZOOM }
      )
    } else {
      map.flyTo({ center: [request.lon, request.lat], zoom: FOCUS_POINT_ZOOM, padding, duration: 800 })
    }
  }, [map, request, padding])
  return null
}

function FitOnRequest({
  request,
  routeCoords,
  padding,
}: {
  request: number
  routeCoords: [number, number][]
  padding: PaddingOptions
}) {
  const { current: map } = useMap()
  const handledRef = useRef(0)
  useEffect(() => {
    if (!map || request === handledRef.current || routeCoords.length < 2) return
    const bounds = getRouteBounds(routeCoords, [], [])
    if (!bounds) return
    handledRef.current = request
    map.fitBounds(bounds, { padding, duration: 500 })
  }, [map, request, routeCoords, padding])
  return null
}

function FitBounds({
  routeCoords,
  candidates,
  existingWaypoints,
  disabled,
  padding,
}: {
  routeCoords: [number, number][]
  candidates: Candidate[]
  existingWaypoints: ExistingWaypoint[]
  padding: PaddingOptions
  // Suppressed while the route planner is active: routeCoords changes on
  // every anchor placed or dragged, and refitting on each one yanks the
  // viewport out from under the visitor mid-edit.
  disabled?: boolean
}) {
  const { current: map } = useMap()
  // Tracks the last bounds actually applied, by value rather than by the
  // candidates/routeCoords/existingWaypoints array *references* below -
  // App.tsx hands this a freshly-built array on every render (e.g. after a
  // click-added POI is included), so a reference-only dependency check
  // would re-fit/re-zoom the map even when the computed bounds are
  // identical to what's already applied.
  const lastAppliedBoundsRef = useRef<string | null>(null)

  useEffect(() => {
    if (!map || disabled) return
    const bounds = getRouteBounds(routeCoords, candidates, existingWaypoints)
    if (!bounds) return
    const key = JSON.stringify(bounds)
    if (key === lastAppliedBoundsRef.current) return
    lastAppliedBoundsRef.current = key
    map.fitBounds(bounds, { padding, duration: 0 })
  }, [map, routeCoords, candidates, existingWaypoints, disabled, padding])

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
  onSelect,
  highlighted = false,
  onHover,
  background,
}: {
  point: [number, number]
  icon: typeof Play
  color: string
  background?: string
  label: string
  tooltip: string
  onDragEnd?: (point: [number, number], droppedOnRoute: boolean) => void
  onSelect?: () => void
  highlighted?: boolean
  onHover?: (hovering: boolean) => void
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
      onClick={(e) => {
        e.originalEvent.stopPropagation()
        onSelect?.()
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            aria-label={label}
            className={onDragEnd ? "cursor-grab active:cursor-grabbing" : undefined}
            onMouseEnter={onHover && (() => onHover(true))}
            onMouseLeave={onHover && (() => onHover(false))}
          >
            <CircleMarkerIcon icon={icon} bgColor={color} background={background} highlighted={highlighted} />
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
  onSelect,
  hovered = null,
  onHover,
  finishesAtStart = false,
}: {
  routeCoords: [number, number][]
  // Planning a loop or out-and-back: one combined start/finish marker, which
  // drags, selects and hovers as the start.
  finishesAtStart?: boolean
  onMoveEndpoint?: (which: "start" | "end", point: [number, number], droppedOnRoute: boolean) => void
  // Planning only: clicking an end selects it (see PlanningProps.selectedAnchor),
  // and hovering is shared with the point list (PlanningProps.hoveredAnchor).
  onSelect?: (which: "start" | "end") => void
  hovered?: "start" | "end" | null
  onHover?: (which: "start" | "end" | null) => void
}) {
  if (routeCoords.length === 0) return null
  const start = routeCoords[0]
  const end = routeCoords[routeCoords.length - 1]
  const isLoop = start[0] === end[0] && start[1] === end[1]
  const dragTooltip = " - drag to move, or onto the route to trim"

  // A route that's still just its first planned point has a start and no end
  // yet - drawing both would stack the end marker on top of the start.
  if (routeCoords.length === 1) {
    return (
      <EndpointMarker
        point={start}
        icon={Play}
        color={ROUTE_START_COLOR}
        label="Route start"
        tooltip={onMoveEndpoint ? "Start - drag to move" : "Start"}
        onDragEnd={onMoveEndpoint ? (point, onRoute) => onMoveEndpoint("start", point, onRoute) : undefined}
        onSelect={onSelect && (() => onSelect("start"))}
        highlighted={hovered === "start"}
        onHover={onHover && ((on) => onHover(on ? "start" : null))}
      />
    )
  }

  // A route that finishes where it starts gets one marker in both colours -
  // a loaded loop, or a loop/out-and-back being planned. (A one-way route
  // being planned whose ends happen to meet keeps both, so each end stays
  // grabbable on its own.)
  if ((isLoop && !onMoveEndpoint) || finishesAtStart) {
    return (
      <EndpointMarker
        point={start}
        icon={Flag}
        color={ROUTE_START_COLOR}
        background={START_FINISH_BACKGROUND}
        label="Route start and finish"
        tooltip={onMoveEndpoint ? "Start / Finish - drag to move" : "Start / Finish"}
        onDragEnd={onMoveEndpoint ? (point, onRoute) => onMoveEndpoint("start", point, onRoute) : undefined}
        onSelect={onSelect && (() => onSelect("start"))}
        highlighted={hovered === "start"}
        onHover={onHover && ((on) => onHover(on ? "start" : null))}
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
        onSelect={onSelect && (() => onSelect("start"))}
        highlighted={hovered === "start"}
        onHover={onHover && ((on) => onHover(on ? "start" : null))}
      />
      <EndpointMarker
        point={end}
        icon={Square}
        color={ROUTE_END_COLOR}
        label="Route end"
        tooltip={onMoveEndpoint ? `End${dragTooltip}` : "End"}
        onDragEnd={onMoveEndpoint ? (point, onRoute) => onMoveEndpoint("end", point, onRoute) : undefined}
        onSelect={onSelect && (() => onSelect("end"))}
        highlighted={hovered === "end"}
        onHover={onHover && ((on) => onHover(on ? "end" : null))}
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
          className="bg-background shadow-md touch-none"
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

const PLANNER_ANCHOR_COLOR = PLANNER_POINT_COLOR
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
/**
 * How a planner point is named - interior points match the number on their
 * marker, and a route that finishes at its start has no separate end.
 */
function anchorLabel(anchorIndex: number, anchorCount: number, shape: RouteShape): string {
  if (anchorIndex === 0) return shape === "one-way" ? "Start" : "Start / Finish"
  if (anchorIndex === anchorCount - 1 && shape === "one-way") return "End"
  return `Point ${anchorIndex}`
}

// Opened by clicking a planner point, and the only sign it's selected: the
// one place to delete it by pointer (Delete/Backspace does the same from the
// keyboard - see App.tsx). Clicking
// elsewhere on the map closes it, via the Popup's default closeOnClick.
function SelectedPointPopup({
  point,
  label,
  onDelete,
  onClose,
}: {
  point: [number, number]
  label: string
  onDelete: () => void
  onClose: () => void
}) {
  return (
    <Popup longitude={point[1]} latitude={point[0]} anchor="bottom" offset={20} onClose={onClose}>
      <div className="flex flex-col gap-2 pr-4 text-sm">
        <span className="font-medium">{label}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="destructive" size="sm" onClick={onDelete}>
              <Trash2Icon className="size-4" />
              Delete point
            </Button>
          </TooltipTrigger>
          {/* To the side: above would cover the popup's title, below the point itself. */}
          <TooltipContent side="right">Or press Delete</TooltipContent>
        </Tooltip>
      </div>
    </Popup>
  )
}

function PlannerAnchorMarker({
  number,
  highlighted,
  onHover,
}: {
  number: number
  highlighted: boolean
  onHover: (hovering: boolean) => void
}) {
  return (
    <div
      aria-label={`Route point ${number}`}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className="flex cursor-grab items-center justify-center rounded-full border-2 border-white text-[11px] font-semibold leading-none text-white active:cursor-grabbing"
      style={{
        width: PLANNER_ANCHOR_SIZE,
        height: PLANNER_ANCHOR_SIZE,
        backgroundColor: PLANNER_ANCHOR_COLOR,
        // The same glow CircleMarkerIcon's `highlighted` gives the start/end.
        boxShadow: highlighted
          ? `0 1px 3px rgba(0,0,0,0.4), 0 0 0 4px color-mix(in oklch, ${PLANNER_ANCHOR_COLOR} 40%, transparent)`
          : "0 1px 3px rgba(0,0,0,0.4)",
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
/**
 * Reports the distance along the route under the pointer while hovering the
 * route line, so the elevation profile's crosshair follows it (see
 * lib/hoverDistance). Bound to the same wide hit layer the line-drag uses.
 */
function RouteHoverReporter({ routeCoords }: { routeCoords: [number, number][] }) {
  const { current: map } = useMap()
  const coordsRef = useRef(routeCoords)
  useEffect(() => {
    coordsRef.current = routeCoords
  }, [routeCoords])

  useEffect(() => {
    if (!map) return
    const handleMove = (e: MapLayerMouseEvent) => {
      const { distanceFromStartM } = projectOntoPolylineM([e.lngLat.lat, e.lngLat.lng], coordsRef.current)
      setHoveredDistanceM(distanceFromStartM)
    }
    const handleLeave = () => setHoveredDistanceM(null)
    map.on("mousemove", ROUTE_HIT_LAYER_ID, handleMove)
    map.on("mouseleave", ROUTE_HIT_LAYER_ID, handleLeave)
    return () => {
      map.off("mousemove", ROUTE_HIT_LAYER_ID, handleMove)
      map.off("mouseleave", ROUTE_HIT_LAYER_ID, handleLeave)
      setHoveredDistanceM(null)
    }
  }, [map])

  return null
}

/** A dot on the route at the distance hovered in the elevation profile (or on the route itself). */
function HoveredDistanceMarker({ routeCoords }: { routeCoords: [number, number][] }) {
  const hoveredM = useHoveredDistanceM()
  const cumulative = useMemo(() => cumulativeDistancesM(routeCoords), [routeCoords])
  if (hoveredM === null) return null
  const point = pointAtDistanceM(routeCoords, cumulative, hoveredM)
  if (!point) return null
  return (
    <Marker longitude={point[1]} latitude={point[0]} style={{ zIndex: HOVERED_Z_INDEX, pointerEvents: "none" }}>
      <div
        className="rounded-full border-2 border-white"
        style={{ width: 14, height: 14, backgroundColor: PLANNER_POINT_COLOR, boxShadow: "0 1px 3px rgba(0,0,0,0.4)" }}
      />
    </Marker>
  )
}

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

// The basemap's own POI icons (source-layer "poi" on road-cycling.json's
// vector source) - filtered at runtime (see BasemapPoiFilter) down to only
// our addable poi_types, and made clickable via interactiveLayerIds on
// <Map>. poi_r1 is included even though its icon/text-size is already
// zeroed in the style, for consistency should that ever change; poi_transit
// (airport/rail/bus labels) is deliberately left unfiltered - those are
// orientation landmarks, not "things you can add to your route".
const BASEMAP_POI_LAYER_IDS = ["poi_r20", "poi_r7", "poi_r1"]

function osmEditNodeUrl(osmId: number): string {
  return `https://www.openstreetmap.org/edit?editor=id&node=${osmId}`
}

function osmEditNewNodeUrl(lat: number, lon: number): string {
  return `https://www.openstreetmap.org/edit#map=19/${lat}/${lon}`
}

// A tag's own label, with the wiki-link info icon and (for a date-like tag,
// e.g. check_date/survey:date - see osmTagLabels' "Last verified" label) an
// exact-timestamp tooltip on hover.
function OsmTagLabel({ tag }: { tag: FormattedOsmTag }) {
  const label = (
    <span className="truncate">{tag.label}</span>
  )
  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      {tag.isDate ? (
        <Tooltip>
          <TooltipTrigger asChild>{label}</TooltipTrigger>
          <TooltipContent>{formatExactDateTime(tag.value)}</TooltipContent>
        </Tooltip>
      ) : (
        label
      )}
      <a
        href={tag.wikiUrl}
        target="_blank"
        rel="noreferrer"
        title={`Learn more about "${tag.key}" on the OSM wiki`}
        aria-label={`Learn more about ${tag.label} on the OSM wiki`}
        className="shrink-0 text-muted-foreground/70 hover:text-primary"
      >
        <Info className="size-3" />
      </a>
    </span>
  )
}

// Renders every OSM tag on a node except `name` (already shown as the
// popup's header), tags promoted elsewhere in the popup (see PoiEditMeta),
// and the excluded pure-provenance keys - deliberately generic rather than
// a hardcoded field list, since "as much info as OSM has" means whatever
// tags happen to be present, grouped/paired where that reads better (see
// osmTagLabels.groupOsmTags). A table (property name as each row's <th>)
// reads better than a plain list once there are more than a couple of rows.
// Values are truncated (see osmTagLabels.truncateOsmValue) rather than left
// to wrap/overflow, since a long unbroken value (a URL) can force the popup
// wider than its maxWidth. Wrapped in its own scroll container (rather than
// the whole popup scrolling) so the header/checkbox/edit-link stay visible
// once a tag-heavy POI's table exceeds the popup's own max-height (see
// index.css's --rm-map-height-driven .maplibregl-popup-content rule).
function OsmTagList({ tags }: { tags: Record<string, string> }) {
  const entries = groupOsmTags(tags)
  if (entries.length === 0) return null
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <table className="w-full mt-1 text-xs text-muted-foreground">
        <tbody>
          {entries.map((tag) => (
            <tr key={tag.key} className="border-1">
              <th scope="row" className="bg-olive-100 pl-1 py-1.5 pr-3 text-left font-medium align-top whitespace-nowrap">
                <OsmTagLabel tag={tag} />
              </th>
              <td className="pl-1 py-1.5 min-w-0 break-words align-top">
                {tag.href ? (
                  <a
                    href={tag.href}
                    target="_blank"
                    rel="noreferrer"
                    title={tag.value}
                    className="text-primary underline"
                  >
                    {tag.displayValue}
                  </a>
                ) : (
                  <span title={tag.value}>{tag.displayValue}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// "Last edited on OSM ..." / "Last verified ..." info lines shown above the
// tag table - distinct from a mapper-set check_date/survey:date tag's own
// exact-time tooltip inside the table (see OsmTagLabel), this pairs OSM's
// own edit-history timestamp (PoiLookupResult.last_edited /
// CandidateDetails.last_edited) with the same mapper-set verification date,
// promoted out of OsmTagList (see osmTagLabels.groupOsmTags) so it isn't
// shown twice.
function PoiEditMeta({ lastEdited, tags }: { lastEdited: string | null; tags: Record<string, string> }) {
  const lastVerified = tags.check_date ?? tags["survey:date"]
  if (!lastEdited && !lastVerified) return null
  return (
    <>
      {lastEdited && (
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="text-xs text-muted-foreground w-fit">
              Last edited on OSM {formatRelativeDate(lastEdited)}
            </p>
          </TooltipTrigger>
          <TooltipContent>{formatExactDateTime(lastEdited)}</TooltipContent>
        </Tooltip>
      )}
      {lastVerified && (
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="text-xs text-muted-foreground w-fit">
              Last verified {formatRelativeDate(lastVerified)}
            </p>
          </TooltipTrigger>
          <TooltipContent>{formatExactDateTime(lastVerified)}</TooltipContent>
        </Tooltip>
      )}
    </>
  )
}

// Shared popup body for both a route-search candidate and a basemap-click
// lookup result - the two are both real OSM nodes and were previously
// rendered by two independently hand-written JSX blocks that had drifted
// out of sync (a search-found candidate's popup showed no tags/edit info at
// all). The existing-waypoint popup deliberately does NOT use this - an
// ExistingWaypoint is parsed straight from the visitor's own GPX file, has
// no osm_id/tags, so there's no OSM data here to show for it.
function PoiPopupContent({
  icon: Icon,
  color,
  name,
  poiTypeLabel,
  tags,
  lastEdited,
  osmEditUrl,
  metaLine,
  footer,
}: {
  icon: LucideIcon
  color: string
  name: string | null
  poiTypeLabel: string | undefined
  tags: Record<string, string>
  lastEdited: string | null
  osmEditUrl: string
  metaLine?: ReactNode
  footer?: ReactNode
}) {
  return (
    <>
      <div className="shrink-0">
        <div className="flex items-center gap-1 font-medium">
          <Icon className="size-4" style={{ color }} />
          {name || (poiTypeLabel ?? "Point of interest")}
        </div>
        <PoiTypeLabel name={name} label={poiTypeLabel} />
        <PoiEditMeta lastEdited={lastEdited} tags={tags} />
        {metaLine}
      </div>
      <OsmTagList tags={tags} />
      <div className="shrink-0">
        {footer}
        <a href={osmEditUrl} target="_blank" rel="noreferrer" className="text-xs text-primary underline">
          Edit on OpenStreetMap
        </a>
      </div>
    </>
  )
}

// Applies the addable-types filter to the basemap's own POI layers via
// map.setFilter, ANDed with each layer's existing filter - re-applied on
// every styledata event since a full style reload wipes setFilter calls,
// same as RouteDirectionArrows' custom image. Keeps the static style JSON
// untouched: the class/subclass mapping lives in one place
// (basemapPoiMapping.ts), not duplicated into the style file.
//
// setFilter itself fires another styledata event, so apply() re-running
// naively against whatever getFilter() *currently* returns would nest
// ["all", ["all", ["all", ...]]] one level deeper every time - an infinite
// loop of style mutations that pegs the render thread and blanks the map.
// Each layer's original filter is captured once (before this component ever
// touches it) and reused as the base on every reapplication; setFilter is
// only called when the computed target actually differs from the current
// filter, which is what breaks the loop.
function BasemapPoiFilter() {
  const { current: mapRef } = useMap()
  // A plain object, not a JS Map - `Map` in this file's scope is
  // react-map-gl's <Map> component.
  const baseFiltersRef = useRef<Record<string, unknown>>({})

  useEffect(() => {
    if (!mapRef) return
    // setFilter/getFilter are handler methods on the underlying maplibre Map,
    // not proxied by react-map-gl's MapRef (same reason dragPan needs
    // getMap() elsewhere in this file).
    const map = mapRef.getMap()
    const addable = buildAddablePoiFilter()
    const apply = () => {
      for (const id of BASEMAP_POI_LAYER_IDS) {
        if (!map.getLayer(id)) continue
        if (!(id in baseFiltersRef.current)) {
          baseFiltersRef.current[id] = map.getFilter(id)
        }
        const base = baseFiltersRef.current[id]
        const target = base ? ["all", base, addable] : addable
        const current = map.getFilter(id)
        if (JSON.stringify(current) === JSON.stringify(target)) continue
        // MapLibre's FilterSpecification type doesn't model dynamically
        // built expressions well - these are valid runtime filter
        // expressions, just not statically typed as such.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.setFilter(id, target as any)
      }
    }
    map.on("styledata", apply)
    apply()
    return () => {
      map.off("styledata", apply)
    }
  }, [mapRef])

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
  candidateDetails = {},
  clickAddedCandidateIds = EMPTY_ID_SET,
  onBasemapPoiClick,
  pendingLookup = null,
  onConfirmPendingLookup,
  onDismissPendingLookup,
  planning,
  insets = NO_INSETS,
  onViewChange,
  fitRequest = 0,
  focusRequest = null,
}: RouteMapProps) {
  const [openPopup, setOpenPopup] = useState<{ kind: "candidate" | "waypoint"; id: number } | null>(null)
  const [bearing, setBearing] = useState(0)
  const [locating, setLocating] = useState(false)
  // [lon, lat] - unlike the rest of this file's [lat, lon] convention, this
  // is stored ready for direct use as a <Marker>'s longitude/latitude props.
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null)
  const mapRef = useRef<MapRef>(null)
  // Whether the pointer is over a clickable basemap POI icon - one of
  // interactiveLayerIds (BASEMAP_POI_LAYER_IDS), i.e. the elements whose
  // onClick triggers a POI lookup around that location. Drives the cursor
  // prop below so hovering one of these (and only these) shows a pointer,
  // like any other clickable element.
  const [hoveringPoiLayer, setHoveringPoiLayer] = useState(false)
  // Observed so index.css's popup max-height and max-width rule can cap
  // a POI popup relative to the map's actual rendered size instead of a
  // fixed pixel guess - MapLibre's popup DOM is a descendant of this
  // wrapper, so the variable cascades to it with no prop plumbing.
  const mapWrapperRef = useRef<HTMLDivElement>(null)
  const attributionHostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = mapWrapperRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      el.style.setProperty("--rm-map-height", `${entry.contentRect.height}px`)
      el.style.setProperty("--rm-map-width", `${entry.contentRect.width}px`)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const hasRoute = routeCoords.length > 0
  const center = hasRoute ? routeCoords[0] : DEFAULT_CENTER
  const zoom = hasRoute ? 13 : DEFAULT_ZOOM
  const isHovering = hoveredPoi !== null
  const styleUrl = MAP_STYLES.find((s) => s.key === mapStyleKey)?.styleUrl ?? MAP_STYLES[0].styleUrl
  // Click-added candidates are excluded from FitBounds's input - including
  // one from its lookup popup shouldn't re-fit/re-zoom the map, since the
  // visitor just clicked that exact spot and already has it in view.
  // Memoized so this array's identity is stable across renders that don't
  // actually change the search-found set (e.g. hover), matching FitBounds'
  // own effect dependency.
  const fitBoundsCandidates = useMemo(
    () => candidates.filter((c) => !clickAddedCandidateIds.has(c.osm_id)),
    [candidates, clickAddedCandidateIds]
  )

  const fitPadding = useMemo(
    () => ({
      top: FIT_PADDING_PX + insets.top,
      right: FIT_PADDING_PX + insets.right,
      bottom: FIT_PADDING_PX + insets.bottom,
      left: FIT_PADDING_PX,
    }),
    [insets]
  )

  const pan = (dx: number, dy: number) => {
    mapRef.current?.getMap().panBy([dx, dy], { duration: 200 })
  }

  const handleCenterOnRoute = () => {
    const map = mapRef.current?.getMap()
    const bounds = getRouteBounds(routeCoords, candidates, existingWaypoints)
    if (!map || !bounds) return
    map.fitBounds(bounds, { padding: fitPadding, duration: 500 })
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
      <div
        ref={mapWrapperRef}
        className="relative h-full w-full"
        // Read by the overlay controls below.
        style={{ "--map-inset-top": `${insets.top}px`, "--map-inset-bottom": `${insets.bottom}px` } as CSSProperties}
      >
        <Map
          ref={mapRef}
          initialViewState={{ longitude: center[1], latitude: center[0], zoom }}
          mapStyle={styleUrl}
          // isolation: every marker and popup is a descendant of this
          // element and carries its own z-index (up to 1500, see the
          // constants above and index.css) - without a stacking context of
          // its own, those would compete with the floating header/sidebar
          // and render on top of them.
          style={{ width: "100%", height: "100%", isolation: "isolate" }}
          onLoad={(e) => {
            const center = e.target.getCenter()
            onViewChange?.({ zoom: e.target.getZoom(), center: [center.lat, center.lng] })
          }}
          onMoveEnd={(e) =>
            onViewChange?.({ zoom: e.viewState.zoom, center: [e.viewState.latitude, e.viewState.longitude] })
          }
          attributionControl={false}
          // Basemap POI icons stop being clickable while planning: a click
          // on the map there means "add a point", and a POI icon sitting
          // where the visitor wants the route to go must not swallow it.
          interactiveLayerIds={planning ? undefined : BASEMAP_POI_LAYER_IDS}
          cursor={!planning && hoveringPoiLayer ? "pointer" : undefined}
          onMouseEnter={() => setHoveringPoiLayer(true)}
          onMouseLeave={() => setHoveringPoiLayer(false)}
          onClick={(e) => {
            if (planning) {
              // Clicking the route itself does nothing - that gesture is
              // reserved for dragging a new point out of the line, and
              // appending to the far end is never what a click on the
              // middle of the route meant.
              if (isOnRouteLine(e.target, e.point)) return
              // With a point's popup open, a click elsewhere just dismisses
              // it - adding a point as well would turn every "never mind"
              // into an edit.
              if (planning.selectedAnchor !== null) {
                planning.onClearSelection()
                return
              }
              planning.onAppendAnchor([e.lngLat.lat, e.lngLat.lng])
              return
            }
            if (e.features && e.features.length > 0) {
              const feature = e.features[0]
              const props = feature.properties as { class?: string; subclass?: string }
              const poiType = resolvePoiTypeFromFeatureProps(props)
              // Use the feature's own point geometry, not the click/tap
              // position - a basemap POI's clickable footprint includes its
              // text label (rendered below the icon, "text-anchor: top"),
              // so a click anywhere on a long name can land many metres from
              // the actual node. The lookup radius is a tight 40m (see
              // main.py's LOOKUP_POI_RADIUS_M), so searching around the
              // click point instead of the real node position is what was
              // causing this to 404 even for real, present POIs.
              const geometry = feature.geometry as { type: string; coordinates?: [number, number] }
              if (poiType && geometry.type === "Point" && geometry.coordinates) {
                const [lng, lat] = geometry.coordinates
                onBasemapPoiClick?.(lat, lng, poiType)
              }
            }
          }}
        >
          <MapHoverDim dimmed={isHovering} />
          <BearingSync onBearingChange={setBearing} />
          <PlanningCursor active={planning !== undefined} />
          <BasemapPoiFilter />

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
                    maxWidth="360px"
                    onClose={() => setOpenPopup(null)}
                  >
                    <PoiPopupContent
                      icon={Icon}
                      color={color}
                      name={candidate.name}
                      poiTypeLabel={poiType?.label}
                      tags={candidateDetails[candidate.osm_id]?.tags ?? {}}
                      lastEdited={candidateDetails[candidate.osm_id]?.last_edited ?? null}
                      osmEditUrl={osmEditNodeUrl(candidate.osm_id)}
                      metaLine={
                        <p className="text-muted-foreground">{candidate.distance_m.toFixed(0)}m from route</p>
                      }
                      footer={
                        hasRoute && (
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
                        )
                      }
                    />
                  </Popup>
                )}
              </Marker>
            )
          })}

          {pendingLookup && (
            <Popup
              longitude={pendingLookup.lon}
              latitude={pendingLookup.lat}
              anchor="bottom"
              offset={16}
              maxWidth="360px"
              onClose={() => onDismissPendingLookup?.()}
            >
              <div className="flex flex-1 min-h-0 flex-col gap-3 text-sm">
                {pendingLookup.status === "loading" && (
                  <p className="text-muted-foreground">Looking up this point…</p>
                )}
                {pendingLookup.status === "error" && (
                  <p className="text-muted-foreground">Couldn't look up this point of interest.</p>
                )}
                {pendingLookup.status === "not_found" && (
                  <>
                    <p className="text-muted-foreground">
                      No OpenStreetMap data found here.
                    </p>
                    <a
                      href={osmEditNewNodeUrl(pendingLookup.lat, pendingLookup.lon)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary underline"
                    >
                      Add it on OpenStreetMap
                    </a>
                  </>
                )}
                {pendingLookup.status === "done" && pendingLookup.result && (
                  <>
                    {(() => {
                      const result = pendingLookup.result
                      const poiType = POI_TYPES.find((p) => p.key === result.poi_type)
                      const Icon = poiType?.icon ?? POI_TYPES[0].icon
                      const color = poiType?.color ?? POI_TYPES[0].color
                      return (
                        <PoiPopupContent
                          icon={Icon}
                          color={color}
                          name={result.name}
                          poiTypeLabel={poiType?.label}
                          tags={result.tags}
                          lastEdited={result.last_edited}
                          osmEditUrl={osmEditNodeUrl(result.osm_id)}
                          footer={
                            hasRoute && (
                              <div className="flex items-center gap-2">
                                <Checkbox
                                  id="pending-lookup-include"
                                  checked={false}
                                  onCheckedChange={() => onConfirmPendingLookup?.()}
                                />
                                <Label htmlFor="pending-lookup-include" className="font-normal">
                                  Include
                                </Label>
                              </div>
                            )
                          }
                        />
                      )
                    })()}
                  </>
                )}
              </div>
            </Popup>
          )}

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
                    maxWidth="360px"
                    onClose={() => setOpenPopup(null)}
                  >
                    <div className="flex flex-col gap-3 text-sm">
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
              {/* Interior points - plus the last one when the route finishes at its start. */}
              {planning.anchors.slice(1, planning.shape === "one-way" ? -1 : undefined).map((anchor, i) => {
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
                    onClick={(e) => {
                      e.originalEvent.stopPropagation()
                      planning.onSelectAnchor(index)
                    }}
                  >
                    <PlannerAnchorMarker
                      number={index}
                      highlighted={planning.hoveredAnchor === index}
                      onHover={(on) => planning.onHoverAnchor(on ? index : null)}
                    />
                  </Marker>
                )
              })}
              <RouteLineInsertHandle routeCoords={routeCoords} onInsertAnchor={planning.onInsertAnchor} />
              <RouteHoverReporter routeCoords={routeCoords} />
              {planning.selectedAnchor !== null && planning.anchors[planning.selectedAnchor] && (
                <SelectedPointPopup
                  // Remounted per point, so switching selection re-anchors it.
                  key={`selected-point-${planning.selectedAnchor}`}
                  point={planning.anchors[planning.selectedAnchor]}
                  label={anchorLabel(planning.selectedAnchor, planning.anchors.length, planning.shape)}
                  onDelete={() => planning.onDeleteAnchor(planning.selectedAnchor!)}
                  onClose={planning.onClearSelection}
                />
              )}
            </>
          )}

          <RouteEndpointMarkers
            routeCoords={routeCoords}
            onMoveEndpoint={planning?.onMoveEndpoint}
            finishesAtStart={planning !== undefined && planning.shape !== "one-way"}
            onSelect={
              planning &&
              ((which) => planning.onSelectAnchor(which === "start" ? 0 : planning.anchors.length - 1))
            }
            hovered={
              !planning || planning.hoveredAnchor === null
                ? null
                : planning.hoveredAnchor === 0
                  ? "start"
                  : planning.hoveredAnchor === planning.anchors.length - 1
                    ? "end"
                    : null
            }
            onHover={
              planning &&
              ((which) =>
                planning.onHoverAnchor(
                  which === null ? null : which === "start" ? 0 : planning.anchors.length - 1
                ))
            }
          />
          {userLocation && (
            <Marker longitude={userLocation[0]} latitude={userLocation[1]}>
              <UserLocationMarker />
            </Marker>
          )}
          <DetachedAttribution hostRef={attributionHostRef} />
          <FitOnRequest request={fitRequest} routeCoords={routeCoords} padding={fitPadding} />
          <FocusOnRequest request={focusRequest} padding={fitPadding} />
          <HoveredDistanceMarker routeCoords={routeCoords} />
          <FitBounds
            routeCoords={routeCoords}
            candidates={fitBoundsCandidates}
            existingWaypoints={existingWaypoints}
            disabled={planning !== undefined}
            padding={fitPadding}
          />
        </Map>

        {/* Outside the isolated <Map>, so it can sit above the sidebar - see
            DetachedAttribution. Also carries MapLibre's corner class so the
            control keeps its stock styling. */}
        <div ref={attributionHostRef} className="map-attribution-corner maplibregl-ctrl-bottom-right" />

        <div className="absolute left-4 top-[calc(var(--map-inset-top)+0.5rem)] z-10">
          <MapLegend candidates={candidates} existingWaypoints={existingWaypoints} mapStyleKey={mapStyleKey} />
        </div>

        {/* Every map control lives in one group on the left: the sidebar
            floats over the right side, so controls there would hang in the
            middle of the map. */}
        <div className="absolute bottom-[calc(var(--map-inset-bottom)+0.5rem)] left-4 z-10 flex flex-col items-start gap-2">
          <div className="grid grid-cols-3 grid-rows-3 gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="bg-background shadow-md col-start-2 row-start-1"
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
                  className="bg-background shadow-md col-start-1 row-start-2"
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
                  className="bg-background shadow-md col-start-3 row-start-2"
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
                  className="bg-background shadow-md col-start-2 row-start-3"
                  onClick={() => pan(0, 100)}
                  aria-label="Pan down"
                >
                  <ChevronDown />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Pan down</TooltipContent>
            </Tooltip>
          </div>

          <div className="grid grid-cols-3 gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="bg-background shadow-md"
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
                  className="bg-background shadow-md"
                  onClick={() => mapRef.current?.getMap().zoomOut({ duration: 200 })}
                  aria-label="Zoom out"
                >
                  <Minus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom out</TooltipContent>
            </Tooltip>
            <CompassControl bearing={bearing} mapRef={mapRef} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="bg-background shadow-md"
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
                  className="bg-background shadow-md"
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
      </div>
    </TooltipProvider>
  )
}
