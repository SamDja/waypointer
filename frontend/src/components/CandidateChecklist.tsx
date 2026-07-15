import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { POI_TYPES } from "@/lib/poiTypes"
import type { Candidate, ExistingWaypoint, PoiSearchConfig } from "@/types/candidate"

export interface CandidateChecklistProps {
  candidates: Candidate[]
  selectedIds: Set<number>
  onToggle: (osmId: number) => void
  searchedPoiTypes: PoiSearchConfig[]
  existingWaypoints: ExistingWaypoint[]
  keptWaypointIndices: Set<number>
  onToggleExistingWaypoint: (index: number) => void
}

export function CandidateChecklist({
  candidates,
  selectedIds,
  onToggle,
  searchedPoiTypes,
  existingWaypoints,
  keptWaypointIndices,
  onToggleExistingWaypoint,
}: CandidateChecklistProps) {
  return (
    <div className="flex flex-col gap-4">
      {searchedPoiTypes.map((search) => {
        const cfg = POI_TYPES.find((p) => p.key === search.poi_type)
        const label = cfg?.label ?? search.poi_type
        const Icon = cfg?.icon
        const typeCandidates = candidates.filter((c) => c.poi_type === search.poi_type)
        return (
          <div key={search.poi_type} className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              {Icon && <Icon className="size-4" />}
              {label}
            </h3>
            {typeCandidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No {label.toLowerCase()} found within {search.max_distance_m}m of this route.
              </p>
            ) : (
              <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                {typeCandidates.map((candidate) => {
                  const id = `candidate-${candidate.osm_id}`
                  return (
                    <li key={candidate.osm_id} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={selectedIds.has(candidate.osm_id)}
                        onCheckedChange={() => onToggle(candidate.osm_id)}
                      />
                      <Label htmlFor={id} className="text-sm font-normal">
                        {candidate.name ? candidate.name + " -" : ""} {candidate.distance_m.toFixed(0)}m away (
                        {candidate.lat.toFixed(5)}, {candidate.lon.toFixed(5)})
                      </Label>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}

      {existingWaypoints.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Already in this file</h3>
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {existingWaypoints.map((waypoint) => {
              const id = `existing-waypoint-${waypoint.index}`
              return (
                <li key={waypoint.index} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={keptWaypointIndices.has(waypoint.index)}
                    onCheckedChange={() => onToggleExistingWaypoint(waypoint.index)}
                  />
                  <Label htmlFor={id} className="text-sm font-normal">
                    {waypoint.name || "(unnamed)"} ({waypoint.lat.toFixed(5)}, {waypoint.lon.toFixed(5)})
                  </Label>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
