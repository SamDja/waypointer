import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import type { Candidate } from "@/types/candidate"

export interface CandidateChecklistProps {
  candidates: Candidate[]
  selectedIds: Set<number>
  onToggle: (osmId: number) => void
}

export function CandidateChecklist({ candidates, selectedIds, onToggle }: CandidateChecklistProps) {
  if (candidates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No drinking water fountains found within 50m of this route.
      </p>
    )
  }

  return (
    <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
      {candidates.map((candidate) => {
        const id = `candidate-${candidate.osm_id}`
        return (
          <li key={candidate.osm_id} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={selectedIds.has(candidate.osm_id)}
              onCheckedChange={() => onToggle(candidate.osm_id)}
            />
            <Label htmlFor={id} className="text-sm font-normal">
              {candidate.name || "(unnamed)"} - {candidate.distance_m.toFixed(0)}m away (
              {candidate.lat.toFixed(5)}, {candidate.lon.toFixed(5)})
            </Label>
          </li>
        )
      })}
    </ul>
  )
}
