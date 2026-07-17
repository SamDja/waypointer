import { useEffect } from "react"
import { MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap } from "react-leaflet"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import "leaflet-polylinedecorator"
import { MapPin, Play, Square } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { PoiTypeCombobox } from "@/components/PoiTypeCombobox"
import { buildCircleDivIcon, ROUTE_END_COLOR, ROUTE_START_COLOR } from "@/lib/mapIcons"
import { POI_TYPES } from "@/lib/poiTypes"
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
}

const DEFAULT_CENTER: [number, number] = [46.06352, 11.12864]
const DEFAULT_ZOOM = 14
const EXISTING_WAYPOINT_COLOR = colors.pink[500]
const DIMMED_OPACITY = 0.32
const MAP_TILES_DIMMED_OPACITY = 0.60

function FitBounds({
  routeCoords,
  candidates,
  existingWaypoints,
}: {
  routeCoords: [number, number][]
  candidates: Candidate[]
  existingWaypoints: ExistingWaypoint[]
}) {
  const map = useMap()

  useEffect(() => {
    if (routeCoords.length === 0) return
    const bounds = L.latLngBounds(routeCoords)
    for (const candidate of candidates) {
      bounds.extend([candidate.lat, candidate.lon])
    }
    for (const waypoint of existingWaypoints) {
      bounds.extend([waypoint.lat, waypoint.lon])
    }
    map.fitBounds(bounds, { padding: [20, 20] })
  }, [map, routeCoords, candidates, existingWaypoints])

  return null
}

function RouteEndpointMarkers({ routeCoords }: { routeCoords: [number, number][] }) {
  if (routeCoords.length === 0) return null
  const start = routeCoords[0]
  const end = routeCoords[routeCoords.length - 1]
  const isLoop = start[0] === end[0] && start[1] === end[1]

  if (isLoop) {
    return (
      <Marker position={start} icon={buildCircleDivIcon({ icon: Play, bgColor: ROUTE_START_COLOR })}>
        <Tooltip>Start / End</Tooltip>
      </Marker>
    )
  }

  return (
    <>
      <Marker position={start} icon={buildCircleDivIcon({ icon: Play, bgColor: ROUTE_START_COLOR })}>
        <Tooltip>Start</Tooltip>
      </Marker>
      <Marker position={end} icon={buildCircleDivIcon({ icon: Square, bgColor: ROUTE_END_COLOR })}>
        <Tooltip>End</Tooltip>
      </Marker>
    </>
  )
}

function RouteDirectionArrows({ routeCoords }: { routeCoords: [number, number][] }) {
  const map = useMap()

  useEffect(() => {
    if (routeCoords.length < 2) return

    const polyline = L.polyline(routeCoords)
    const decorator = L.polylineDecorator(polyline, {
      patterns: [
        {
          offset: 100,
          repeat: 200,
          symbol: L.Symbol.marker({
            rotate: true,
            markerOptions: {
              interactive: false,
              icon: L.icon({
                iconUrl: '/arrow-big.svg',
                iconAnchor: [12, 24],
              }),
            }
          }),
        },
      ],
    })
    decorator.addTo(map)

    return () => {
      decorator.remove()
    }
  }, [map, routeCoords])

  return null
}

function PoiTypeLabel({ name, label }: { name: string | null; label: string | undefined }) {
  if (name) {
    return (<p className="text-muted-foreground">{label ?? "Point of interest"}</p>)
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
}: RouteMapProps) {
  const hasRoute = routeCoords.length > 0
  const center = hasRoute ? routeCoords[0] : DEFAULT_CENTER
  const zoom = hasRoute ? 13 : DEFAULT_ZOOM
  const isHovering = hoveredPoi !== null

  return (
    <div className="h-full w-full">
      <MapContainer center={center} zoom={zoom} className="h-full w-full">
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          opacity={isHovering ? MAP_TILES_DIMMED_OPACITY : 1}
        />
        {hasRoute && (
          <Polyline
            positions={routeCoords}
            pathOptions={{ color: colors.violet[600], weight: 3 }}
          />
        )}
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
              position={[candidate.lat, candidate.lon]}
              icon={buildCircleDivIcon({
                icon: Icon,
                iconColor: isSelected ? colors.white : colors.mist[400],
                bgColor: isSelected ? color : colors.mist[200],
              })}
              opacity={isHovered ? 1 : isHovering ? DIMMED_OPACITY : 1}
            >
              <Popup>
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
              position={[waypoint.lat, waypoint.lon]}
              icon={buildCircleDivIcon({
                icon: Icon,
                iconColor: isKept ? colors.white : colors.mist[400],
                bgColor: isKept ? color : colors.mist[200],
              })}
              opacity={isHovered ? 1 : isHovering ? DIMMED_OPACITY : 1}
            >
              <Popup>
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
            </Marker>
          )
        })}
        <RouteEndpointMarkers routeCoords={routeCoords} />
        <RouteDirectionArrows routeCoords={routeCoords} />
        <FitBounds routeCoords={routeCoords} candidates={candidates} existingWaypoints={existingWaypoints} />
      </MapContainer>
    </div>
  )
}
