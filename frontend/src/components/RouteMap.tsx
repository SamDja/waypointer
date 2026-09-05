import { useEffect, useRef, useState } from "react"
import { Layer, Map, Marker, Popup, Source, useMap, type MapRef } from "react-map-gl/maplibre"
import "maplibre-gl/dist/maplibre-gl.css"
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
import { buildAddablePoiFilter, resolvePoiTypeFromFeatureProps } from "@/lib/basemapPoiMapping"
import { CircleMarkerIcon, ROUTE_END_COLOR, ROUTE_START_COLOR, UserLocationMarker } from "@/lib/mapIcons"
import { MAP_STYLES } from "@/lib/mapStyles"
import { POI_TYPES } from "@/lib/poiTypes"
import { toast } from "@/lib/toast"
import type { Candidate, ExistingWaypoint, HoveredPoi, PoiLookupResult } from "@/types/candidate"
import colors from "tailwindcss/colors"

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
  onMapStyleChange: (key: string) => void
  // Raw OSM tags for candidates that were added by clicking a basemap POI
  // icon (keyed by osm_id) - search-found candidates have no entry here and
  // keep their plain popup. See App.tsx's clickAddedTags.
  candidateTags?: Record<number, Record<string, string>>
  onBasemapPoiClick?: (lat: number, lon: number, poiType: string) => void
  pendingLookup?: PendingPoiLookup | null
  onConfirmPendingLookup?: () => void
  onDismissPendingLookup?: () => void
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
}: {
  routeCoords: [number, number][]
  candidates: Candidate[]
  existingWaypoints: ExistingWaypoint[]
}) {
  const { current: map } = useMap()

  useEffect(() => {
    if (!map) return
    const bounds = getRouteBounds(routeCoords, candidates, existingWaypoints)
    if (!bounds) return
    map.fitBounds(bounds, { padding: 20, duration: 0 })
  }, [map, routeCoords, candidates, existingWaypoints])

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

function RouteEndpointMarkers({ routeCoords }: { routeCoords: [number, number][] }) {
  if (routeCoords.length === 0) return null
  const start = routeCoords[0]
  const end = routeCoords[routeCoords.length - 1]
  const isLoop = start[0] === end[0] && start[1] === end[1]

  if (isLoop) {
    return (
      <Marker longitude={start[1]} latitude={start[0]} style={{ zIndex: ROUTE_ENDPOINT_Z_INDEX }}>
        <Tooltip>
          <TooltipTrigger asChild>
            <CircleMarkerIcon icon={Play} bgColor={ROUTE_START_COLOR} />
          </TooltipTrigger>
          <TooltipContent>Start / End</TooltipContent>
        </Tooltip>
      </Marker>
    )
  }

  return (
    <>
      <Marker longitude={start[1]} latitude={start[0]} style={{ zIndex: ROUTE_ENDPOINT_Z_INDEX }}>
        <Tooltip>
          <TooltipTrigger asChild>
            <CircleMarkerIcon icon={Play} bgColor={ROUTE_START_COLOR} />
          </TooltipTrigger>
          <TooltipContent>Start</TooltipContent>
        </Tooltip>
      </Marker>
      <Marker longitude={end[1]} latitude={end[0]} style={{ zIndex: ROUTE_ENDPOINT_Z_INDEX }}>
        <Tooltip>
          <TooltipTrigger asChild>
            <CircleMarkerIcon icon={Square} bgColor={ROUTE_END_COLOR} />
          </TooltipTrigger>
          <TooltipContent>End</TooltipContent>
        </Tooltip>
      </Marker>
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

// Renders every OSM tag on a node except `name` (already shown as the
// popup's header) - deliberately generic rather than a hardcoded field list,
// since "as much info as OSM has" means whatever tags happen to be present.
function OsmTagList({ tags }: { tags: Record<string, string> }) {
  const entries = Object.entries(tags).filter(([key]) => key !== "name")
  if (entries.length === 0) return null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="font-medium">{key}</dt>
          <dd className="break-words">{value}</dd>
        </div>
      ))}
    </dl>
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
  onMapStyleChange,
  candidateTags = {},
  onBasemapPoiClick,
  pendingLookup = null,
  onConfirmPendingLookup,
  onDismissPendingLookup,
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
          interactiveLayerIds={BASEMAP_POI_LAYER_IDS}
          onClick={(e) => {
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
          <BasemapPoiFilter />

          {hasRoute && (
            <Source id={ROUTE_SOURCE_ID} type="geojson" data={toRouteLineGeoJson(routeCoords)}>
              <Layer id="route-line" type="line" paint={{ "line-color": ROUTE_LINE_COLOR, "line-width": 3 }} />
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
                      {candidateTags[candidate.osm_id] && (
                        <OsmTagList tags={candidateTags[candidate.osm_id]} />
                      )}
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
                      <a
                        href={osmEditNodeUrl(candidate.osm_id)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary underline"
                      >
                        Edit on OpenStreetMap
                      </a>
                    </div>
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
              onClose={() => onDismissPendingLookup?.()}
            >
              <div className="flex flex-col gap-2 text-sm">
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
                        <>
                          <div className="flex items-center gap-1 font-medium">
                            <Icon className="size-4" style={{ color }} />
                            {result.name || (poiType?.label ?? "Point of interest")}
                          </div>
                          <PoiTypeLabel name={result.name} label={poiType?.label} />
                          <OsmTagList tags={result.tags} />
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
                          <a
                            href={osmEditNodeUrl(result.osm_id)}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-primary underline"
                          >
                            Edit on OpenStreetMap
                          </a>
                        </>
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

          <RouteEndpointMarkers routeCoords={routeCoords} />
          {userLocation && (
            <Marker longitude={userLocation[0]} latitude={userLocation[1]}>
              <UserLocationMarker />
            </Marker>
          )}
          <FitBounds routeCoords={routeCoords} candidates={candidates} existingWaypoints={existingWaypoints} />
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
