import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { formatDistanceM } from "@/lib/geometry"
import { POI_TYPES } from "@/lib/poiTypes"
import type { Candidate, PoiSearchConfig } from "@/types/candidate"

export interface CandidateChecklistProps {
  candidates: Candidate[]
  selectedIds: Set<number>
  onToggle: (osmId: number) => void
  searchedPoiTypes: PoiSearchConfig[]
}

export function CandidateChecklist({
  candidates,
  selectedIds,
  onToggle,
  searchedPoiTypes,
}: CandidateChecklistProps) {
  return (
    <div className="flex flex-col gap-4">
      {POI_TYPES.filter((cfg) => cfg.searchable).map((cfg) => {
        const Icon = cfg.icon
        const typeCandidates = candidates.filter((c) => c.poi_type === cfg.key)
        const search = searchedPoiTypes.find((s) => s.poi_type === cfg.key)

        // Nothing to show for this type: no candidates found and it wasn't
        // even searched for.
        if (typeCandidates.length === 0 && !search) return null

        return (
          <div key={cfg.key} className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              <Icon className="size-4" color={cfg.color} />
              {cfg.label}
            </h3>
            {typeCandidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No {cfg.label.toLowerCase()} found within {search!.max_distance_m}m of this route.
              </p>
            ) : (
              <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                {typeCandidates.sort((a,b) => a.distance_from_start_m - b.distance_from_start_m).map((candidate) => {
                  const id = `candidate-${candidate.osm_id}`
                  return (
                    <li key={id} className="flex items-center gap-2 bg-gray-100 p-2 rounded-xl">
                      <Checkbox
                        id={id}
                        checked={selectedIds.has(candidate.osm_id)}
                        onCheckedChange={() => onToggle(candidate.osm_id)}
                      />
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
    </div>
  )
}
