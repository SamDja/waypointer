import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { POI_TYPES } from "@/lib/poiTypes"
import type { PoiSearchEntry } from "@/lib/settings"

export interface FindPoisCardProps {
  entries: PoiSearchEntry[]
  onChange: (entries: PoiSearchEntry[]) => void
  onFind: () => void
  disabled: boolean
  isFinding: boolean
}

export function FindPoisCard({ entries, onChange, onFind, disabled, isFinding }: FindPoisCardProps) {
  function updateEntry(poiType: string, changes: Partial<PoiSearchEntry>) {
    onChange(entries.map((entry) => (entry.poiType === poiType ? { ...entry, ...changes } : entry)))
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {POI_TYPES.filter((cfg) => cfg.searchable).map((cfg) => {
          const entry = entries.find((e) => e.poiType === cfg.key)
          const enabled = entry?.enabled ?? true
          const maxDistanceM = entry?.maxDistanceM ?? cfg.defaultMaxDistanceM
          const checkboxId = `poi-enabled-${cfg.key}`
          const distanceId = `poi-distance-${cfg.key}`
          const Icon = cfg.icon
          return (
            <li key={cfg.key} className="flex items-center gap-2">
              <Checkbox
                id={checkboxId}
                checked={enabled}
                onCheckedChange={(checked) => updateEntry(cfg.key, { enabled: checked === true })}
              />
              {Icon  && <Icon className="size-4" color={cfg.color}></Icon>}
              <Label htmlFor={checkboxId} className="text-sm font-bold">
                {cfg.label}
              </Label>
              <span className="text-sm font-normal">within</span>
              <Input
                id={distanceId}
                type="number"
                min={cfg.minDistanceM}
                max={cfg.maxDistanceM}
                value={maxDistanceM}
                disabled={!enabled}
                onChange={(e) => updateEntry(cfg.key, { maxDistanceM: Number(e.target.value) })}
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">m</span>
            </li>
          )
        })}
      </ul>
      <Button onClick={onFind} disabled={disabled} loading={isFinding} className="w-fit">
        {isFinding ? "Finding POIs…" : "Find POIs"}
      </Button>
    </div>
  )
}
