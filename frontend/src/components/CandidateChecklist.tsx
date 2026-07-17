import { PoiListItem } from "@/components/PoiListItem"
import { POI_TYPES } from "@/lib/poiTypes"
import type { Candidate, PoiSearchConfig } from "@/types/candidate"

export interface CandidateChecklistProps {
  candidates: Candidate[]
  selectedIds: Set<number>
  onToggle: (osmId: number) => void
  searchedPoiTypes: PoiSearchConfig[]
  onHoverCandidate?: (osmId: number | null) => void
}

export function CandidateChecklist({
  candidates,
  selectedIds,
  onToggle,
  searchedPoiTypes,
  onHoverCandidate,
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
                {typeCandidates.sort((a,b) => a.distance_from_start_m - b.distance_from_start_m).map((candidate) => (
                  <PoiListItem
                    key={candidate.osm_id}
                    id={`candidate-${candidate.osm_id}`}
                    title={candidate.name || candidate.poi_type}
                    checked={selectedIds.has(candidate.osm_id)}
                    onCheckedChange={() => onToggle(candidate.osm_id)}
                    distanceFromStartM={candidate.distance_from_start_m}
                    distanceFromRouteM={candidate.distance_m}
                    onMouseEnter={() => onHoverCandidate?.(candidate.osm_id)}
                    onMouseLeave={() => onHoverCandidate?.(null)}
                  />
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
