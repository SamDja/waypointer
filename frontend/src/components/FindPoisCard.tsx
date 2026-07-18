import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PoiTypeCombobox } from "@/components/PoiTypeCombobox"
import { POI_TYPES } from "@/lib/poiTypes"
import type { PoiSearchEntry } from "@/lib/settings"
import { Search, XIcon } from "lucide-react"

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

  function removeEntry(poiType: string) {
    onChange(entries.filter((entry) => entry.poiType !== poiType))
  }

  function addEntry(poiType: string) {
    const cfg = POI_TYPES.find((c) => c.key === poiType)
    if (!cfg) return
    onChange([...entries, { poiType, enabled: true, maxDistanceM: cfg.defaultMaxDistanceM! }])
  }

  const addableTypes = POI_TYPES.filter(
    (cfg) => cfg.searchable && !entries.some((entry) => entry.poiType === cfg.key)
  )

  return (
    <div>
      <h3 className="text-base">POI types</h3>
      <div className="flex flex-col rounded-md border p-4 gap-3">
        {entries.length > 0 &&
          <ul className="flex flex-col gap-2 border-b pb-8">
            {entries.map((entry) => {
              const cfg = POI_TYPES.find((c) => c.key === entry.poiType)
              if (!cfg) return null
              const checkboxId = `poi-enabled-${cfg.key}`
              const distanceId = `poi-distance-${cfg.key}`
              const Icon = cfg.icon
              return (
                <li key={cfg.key} className="flex items-center gap-2">
                  <Checkbox
                    id={checkboxId}
                    checked={entry.enabled}
                    onCheckedChange={(checked) => updateEntry(cfg.key, { enabled: checked === true })}
                  />
                  {Icon && <Icon className="size-4" color={cfg.color}></Icon>}
                  <Label htmlFor={checkboxId} className="text-sm font-bold">
                    {cfg.label}
                  </Label>
                  <span className="text-sm font-normal">within</span>
                  <Input
                    id={distanceId}
                    type="number"
                    min={cfg.minDistanceM}
                    max={cfg.maxDistanceM}
                    value={entry.maxDistanceM}
                    disabled={!entry.enabled}
                    onChange={(e) => updateEntry(cfg.key, { maxDistanceM: Number(e.target.value) })}
                    className="w-20"
                  />
                  <span className="text-sm text-muted-foreground">m</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="ml-auto"
                    aria-label={`Remove ${cfg.label}`}
                    onClick={() => removeEntry(cfg.key)}
                  >
                    <XIcon className="size-4" />
                  </Button>
                </li>
              )
            })}
          </ul>
        }
        <div className="grow flex gap-2">

          {addableTypes.length > 0 && (
            <PoiTypeCombobox
              value=""
              options={addableTypes}
              placeholder="Add a POI type…"
              onChange={addEntry}
              className="flex-none"
            />
          )}

          <Button onClick={onFind} disabled={disabled} loading={isFinding} className="grow">
            {isFinding ? "Finding POIs…" : "Find POIs"}
            <Search className="size-4"></Search>
          </Button>
        </div>
      </div>
    </div>
  )
}
