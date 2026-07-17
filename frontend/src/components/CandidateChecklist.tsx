import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { formatDistanceM } from "@/lib/geometry"
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
  // Existing waypoints whose type couldn't be inferred (see
  // lib/gpx.ts's parseExistingWaypointsFromGpx) fall back to a plain
  // "Already in this file" bucket, same as before type inference existed.
  const unmatchedExistingWaypoints = existingWaypoints.filter(
    (w) => !POI_TYPES.some((cfg) => cfg.key === w.poi_type)
  )

  return (
    <div className="flex flex-col gap-4">
      {POI_TYPES.map((cfg) => {
        const Icon = cfg.icon
        const typeCandidates = candidates.filter((c) => c.poi_type === cfg.key)
        const typeExistingWaypoints = existingWaypoints.filter((w) => w.poi_type === cfg.key)
        const search = searchedPoiTypes.find((s) => s.poi_type === cfg.key)

        // Nothing to show for this type: no existing waypoints inferred as
        // this type, no candidates found, and it wasn't even searched for.
        if (typeExistingWaypoints.length === 0 && typeCandidates.length === 0 && !search) return null

        return (
          <div key={cfg.key} className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              <Icon className="size-4" color={cfg.color} />
              {cfg.label}
            </h3>
            {typeExistingWaypoints.length === 0 && typeCandidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No {cfg.label.toLowerCase()} found within {search!.max_distance_m}m of this route.
              </p>
            ) : (
              <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                {typeExistingWaypoints.sort((a,b) => a.distance_from_start_m - b.distance_from_start_m).map((waypoint) => {
                  const id = `existing-waypoint-${waypoint.index}`
                  return (
                    <li key={id} className="flex items-center gap-2 bg-gray-100 p-2 rounded-xl">
                      <Checkbox
                        id={id}
                        checked={keptWaypointIndices.has(waypoint.index)}
                        onCheckedChange={() => onToggleExistingWaypoint(waypoint.index)}
                      />
                      <Label htmlFor={id} className="flex flex-col items-start gap-0 w-full">
                        {waypoint.name && <h4 >{waypoint.name} <span className="text-xs font-normal text-muted-foreground">(already in file)</span></h4>}
                        <span className="text-sm font-normal flex w-full">
                          <span className="grow-1">{formatDistanceM(waypoint.distance_from_start_m)} <span className="text-muted-foreground">from start</span></span>
                          <span className="grow-1">{formatDistanceM(waypoint.distance_from_route_m)} <span className="text-muted-foreground">from track</span></span>
                        </span>
                      </Label>
                    </li>
                  )
                })}
                {typeCandidates.sort((a,b) => a.distance_from_start_m - b.distance_from_start_m).map((candidate) => {
                  const id = `candidate-${candidate.osm_id}`
                  return (
                    <li key={id} className="flex items-center gap-2 bg-gray-100 p-2 rounded-xl">
                      <Checkbox
                        id={id}
                        checked={selectedIds.has(candidate.osm_id)}
                        onCheckedChange={() => onToggle(candidate.osm_id)}
                      />
                      {/* <Label htmlFor={id} className="text-sm font-normal">
                        {candidate.name ? candidate.name + " - " : ""}
                        {formatDistanceM(candidate.distance_m)} from track,{" "}
                        {formatDistanceM(candidate.distance_from_start_m)} from start
                      </Label> */}
                      <Label htmlFor={id} className="flex flex-col items-start gap-0 w-full">
                        {candidate.name ? <h4>{candidate.name}</h4> : <h4>{candidate.poi_type}</h4>}
                        <span className="text-sm font-normal flex w-full">
                          <span className="grow-1">{formatDistanceM(candidate.distance_from_start_m)} <span className="text-muted-foreground">from start</span></span>
                          <span className="grow-1">{formatDistanceM(candidate.distance_m)} <span className="text-muted-foreground">from track</span></span>
                        </span>
                      </Label>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}

      {unmatchedExistingWaypoints.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Already in this file</h3>
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {unmatchedExistingWaypoints.map((waypoint) => {
              const id = `existing-waypoint-${waypoint.index}`
              return (
                <li key={waypoint.index} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={keptWaypointIndices.has(waypoint.index)}
                    onCheckedChange={() => onToggleExistingWaypoint(waypoint.index)}
                  />
                  <Label htmlFor={id} className="text-sm font-normal">
                    {waypoint.name || "(unnamed)"} - {formatDistanceM(waypoint.distance_from_route_m)} from
                    track, {formatDistanceM(waypoint.distance_from_start_m)} from start
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
