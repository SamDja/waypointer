import { useEffect } from "react"
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, useMap } from "react-leaflet"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import { Droplet } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import type { Candidate } from "@/types/candidate"

export interface RouteMapProps {
  routeCoords: [number, number][]
  candidates: Candidate[]
  selectedIds: Set<number>
  onToggle: (osmId: number) => void
}

const DEFAULT_CENTER: [number, number] = [46.06352, 11.12864]
const DEFAULT_ZOOM = 14

function FitBounds({ routeCoords, candidates }: { routeCoords: [number, number][]; candidates: Candidate[] }) {
  const map = useMap()

  useEffect(() => {
    if (routeCoords.length === 0) return
    const bounds = L.latLngBounds(routeCoords)
    for (const candidate of candidates) {
      bounds.extend([candidate.lat, candidate.lon])
    }
    map.fitBounds(bounds, { padding: [20, 20] })
  }, [map, routeCoords, candidates])

  return null
}

export function RouteMap({ routeCoords, candidates, selectedIds, onToggle }: RouteMapProps) {
  const hasRoute = routeCoords.length > 0
  const center = hasRoute ? routeCoords[0] : DEFAULT_CENTER
  const zoom = hasRoute ? 13 : DEFAULT_ZOOM

  return (
    <div className="h-full w-full">
      <MapContainer center={center} zoom={zoom} className="h-full w-full">
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        {hasRoute && <Polyline positions={routeCoords} pathOptions={{ color: "#2563eb", weight: 4 }} />}
        {candidates.map((candidate) => {
          const isSelected = selectedIds.has(candidate.osm_id)
          const checkboxId = `map-candidate-${candidate.osm_id}`
          return (
            <CircleMarker
              key={candidate.osm_id}
              center={[candidate.lat, candidate.lon]}
              radius={8}
              pathOptions={{
                color: "#16a34a",
                fillColor: "#16a34a",
                fillOpacity: isSelected ? 0.9 : 0.25,
                opacity: isSelected ? 1 : 0.35,
              }}
            >
              <Popup>
                <div className="flex flex-col gap-2 text-sm">
                  <div className="flex items-center gap-1 font-medium">
                    <Droplet className="size-4 text-blue-600" />
                    {candidate.name || "(unnamed)"}
                  </div>
                  <p className="text-muted-foreground">Drinking water fountain</p>
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
            </CircleMarker>
          )
        })}
        <FitBounds routeCoords={routeCoords} candidates={candidates} />
      </MapContainer>
    </div>
  )
}
