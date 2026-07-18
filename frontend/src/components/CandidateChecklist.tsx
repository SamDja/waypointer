import { useState } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { PoiListItem } from "@/components/PoiListItem"
import { POI_TYPES } from "@/lib/poiTypes"
import { cn } from "@/lib/utils"
import type { Candidate, PoiSearchConfig } from "@/types/candidate"

export interface CandidateChecklistProps {
  candidates: Candidate[]
  selectedIds: Set<number>
  onToggle: (osmId: number) => void
  onToggleAll: (checked: boolean, osmIds: number[]) => void
  searchedPoiTypes: PoiSearchConfig[]
  onHoverCandidate?: (osmId: number | null) => void
}

export function CandidateChecklist({
  candidates,
  selectedIds,
  onToggle,
  onToggleAll,
  searchedPoiTypes,
  onHoverCandidate,
}: CandidateChecklistProps) {
  const [filter, setFilter] = useState<string>("all")

  if (candidates.length === 0) {
    if (searchedPoiTypes.length === 0) return null
    return (
      <p className="text-sm text-muted-foreground">
        No POIs found within your search settings (
        {searchedPoiTypes
          .map((s) => `${POI_TYPES.find((cfg) => cfg.key === s.poi_type)?.label ?? s.poi_type} within ${s.max_distance_m}m`)
          .join(", ")}
        ).
      </p>
    )
  }

  // Filter chips reflect what's actually in the results, not the full
  // searched set - a searched-but-empty type has nothing to filter to.
  const presentTypes = Array.from(new Set(candidates.map((c) => c.poi_type)))
    .map((key) => POI_TYPES.find((cfg) => cfg.key === key))
    .filter((cfg): cfg is NonNullable<typeof cfg> => cfg !== undefined)

  const visible = (filter === "all" ? candidates : candidates.filter((c) => c.poi_type === filter))
    .slice()
    .sort((a, b) => a.distance_from_start_m - b.distance_from_start_m)

  function chipClass(active: boolean) {
    return cn(
      "flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium cursor-pointer",
      active ? "bg-primary text-primary-foreground" : "bg-olive-100 text-stone-800 hover:bg-olive-200"
    )
  }

  return (
    <div>
      <h3 className="text-base">Results</h3>
      <div className="flex flex-col rounded-md border p-4 gap-3">
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => setFilter("all")} className={chipClass(filter === "all")}>
            All ({candidates.filter((c) => selectedIds.has(c.osm_id)).length}/{candidates.length})
          </button>
          {presentTypes.map((cfg) => {
            const Icon = cfg.icon
            const typeCandidates = candidates.filter((c) => c.poi_type === cfg.key)
            const selectedCount = typeCandidates.filter((c) => selectedIds.has(c.osm_id)).length
            return (
              <button
                key={cfg.key}
                type="button"
                onClick={() => setFilter(cfg.key)}
                className={chipClass(filter === cfg.key)}
              >
                <Icon className="size-3.5" />
                {cfg.label} ({selectedCount}/{typeCandidates.length})
              </button>
            )
          })}
        </div>

        <div>


          <div className="mb-2 flex items-center gap-3 border-b pb-2">
            <Checkbox
              id="select-all-candidates"
              checked={
                visible.length === 0
                  ? false
                  : visible.every((c) => selectedIds.has(c.osm_id))
                    ? true
                    : visible.some((c) => selectedIds.has(c.osm_id))
                      ? "indeterminate"
                      : false
              }
              onCheckedChange={(checked) =>
                onToggleAll(
                  checked === true,
                  visible.map((c) => c.osm_id)
                )
              }
              className="ml-2"
            />
            <Label htmlFor="select-all-candidates" className="text-xs font-normal text-muted-foreground">
              Select all
            </Label>
          </div>

          <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto">
            {visible.map((candidate) => {
              const cfg = POI_TYPES.find((c) => c.key === candidate.poi_type)
              const Icon = cfg?.icon
              return (
                <PoiListItem
                  key={candidate.osm_id}
                  id={`candidate-${candidate.osm_id}`}
                  title={
                    <span className="flex items-center gap-1.5">
                      {Icon && <Icon className="size-3.5 shrink-0" style={{ color: cfg?.color }} />}
                      <span className="truncate">{candidate.name || cfg?.label || candidate.poi_type}</span>
                    </span>
                  }
                  checked={selectedIds.has(candidate.osm_id)}
                  onCheckedChange={() => onToggle(candidate.osm_id)}
                  distanceFromStartM={candidate.distance_from_start_m}
                  distanceFromRouteM={candidate.distance_m}
                  onMouseEnter={() => onHoverCandidate?.(candidate.osm_id)}
                  onMouseLeave={() => onHoverCandidate?.(null)}
                />
              )
            })}
          </ul>
        </div>
      </div>
    </div>
  )
}
