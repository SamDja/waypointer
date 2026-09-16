import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { PoiTypeCombobox } from "@/components/PoiTypeCombobox"
import { POI_TYPES, type PoiTypeConfig } from "@/lib/poiTypes"
import type { PoiSearchEntry } from "@/lib/settings"
import { CheckIcon, Info, Loader2, Search, TriangleAlert, XIcon } from "lucide-react"

export interface FindPoisSearchProgress {
  total: number
  doneTypes: Set<string>
  erroredTypes: Set<string>
}

export interface FindPoisCardProps {
  entries: PoiSearchEntry[]
  onChange: (entries: PoiSearchEntry[]) => void
  onFind: () => void
  disabled: boolean
  isFinding: boolean
  progress: FindPoisSearchProgress | null
}

export function FindPoisCard({ entries, onChange, onFind, disabled, isFinding, progress }: FindPoisCardProps) {
  function updateEntry(poiType: string, changes: Partial<PoiSearchEntry>) {
    onChange(entries.map((entry) => (entry.poiType === poiType ? { ...entry, ...changes } : entry)))
  }

  function removeEntry(poiType: string) {
    onChange(entries.filter((entry) => entry.poiType !== poiType))
  }

  function addEntry(poiType: string) {
    const cfg = POI_TYPES.find((c) => c.key === poiType)
    if (!cfg) return
    onChange([...entries, { poiType, maxDistanceM: cfg.defaultMaxDistanceM! }])
  }

  const addableTypes = POI_TYPES.filter(
    (cfg) => cfg.searchable && !entries.some((entry) => entry.poiType === cfg.key)
  )

  return (
    <div>
      <h3 className="text-base">POI types</h3>
      <div className="flex flex-col rounded-md border p-4 gap-3">
        {entries.length > 0 &&
          <ul className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-x-2 gap-y-2">
            {entries.map((entry) => {
              const cfg = POI_TYPES.find((c) => c.key === entry.poiType)
              if (!cfg) return null
              const Icon = cfg.icon
              return (
                <li key={cfg.key} className="contents">
                  {Icon && <Icon className="size-4" color={cfg.color}></Icon>}
                  <span className="text-sm font-bold truncate">{cfg.label}</span>
                  <span className="text-sm font-normal">within</span>
                  <PoiDistanceInput
                    id={`poi-distance-${cfg.key}`}
                    value={entry.maxDistanceM}
                    min={cfg.minDistanceM}
                    max={cfg.maxDistanceM}
                    disabled={isFinding}
                    onCommit={(value) => updateEntry(cfg.key, { maxDistanceM: value })}
                  />
                  <span className="text-sm text-muted-foreground">m</span>
                  <span className="flex items-center gap-1">
                    <DistanceInfo cfg={cfg} />
                    {isFinding && progress ? (
                      <RowSearchStatus poiType={cfg.key} label={cfg.label} progress={progress} />
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={isFinding}
                        aria-label={`Remove ${cfg.label}`}
                        onClick={() => removeEntry(cfg.key)}
                      >
                        <XIcon className="size-4" />
                      </Button>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        }
        <div className="flex flex-col border-b gap-2 pb-4">
          {addableTypes.length > 0 && (
            <PoiTypeCombobox
              value=""
              options={addableTypes}
              placeholder="Add a POI type…"
              onChange={addEntry}
              disabled={isFinding}
              className="w-full"
            />
          )}

        </div>
        <div className="flex flex-col">
          <Button onClick={onFind} disabled={disabled} loading={isFinding}>
            {isFinding && progress
              ? `Finding POIs… (${progress.doneTypes.size + progress.erroredTypes.size}/${progress.total})`
              : "Find POIs"}
            <Search className="size-4"></Search>
          </Button>
        </div>
      </div>
    </div>
  )
}

function RowSearchStatus({
  poiType,
  label,
  progress,
}: {
  poiType: string
  label: string
  progress: FindPoisSearchProgress
}) {
  if (progress.erroredTypes.has(poiType)) {
    return (
      <span aria-label={`Couldn't search ${label}`} title={`Couldn't search ${label}`}>
        <TriangleAlert className="size-4 text-amber-600" />
      </span>
    )
  }
  if (progress.doneTypes.has(poiType)) {
    return (
      <span aria-label={`${label} found`} title={`${label} found`}>
        <CheckIcon className="size-4 text-emerald-600" />
      </span>
    )
  }
  return (
    <span aria-label={`Searching ${label}…`} title={`Searching ${label}…`}>
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    </span>
  )
}

function DistanceInfo({ cfg }: { cfg: PoiTypeConfig }) {
  if (cfg.minDistanceM == null || cfg.maxDistanceM == null) return null
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Allowed search distance for ${cfg.label}`}
          >
            <Info className="size-3.5 text-muted-foreground" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Search distance must be between {cfg.minDistanceM} and {cfg.maxDistanceM} m
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

interface PoiDistanceInputProps {
  id: string
  value: number
  min?: number
  max?: number
  disabled: boolean
  onCommit: (value: number) => void
}

// Tracks the field's raw text locally so an emptied input doesn't snap back
// to a controlled "0" mid-edit (which would otherwise leave a stray leading
// zero once the visitor starts typing the next digit).
function PoiDistanceInput({ id, value, min, max, disabled, onCommit }: PoiDistanceInputProps) {
  const [text, setText] = useState(String(value))

  useEffect(() => {
    setText(String(value))
  }, [value])

  function commit(raw: string) {
    const parsed = Number(raw)
    const fallback = min ?? value
    const clamped = raw.trim() === "" || !Number.isFinite(parsed)
      ? fallback
      : Math.min(Math.max(parsed, min ?? parsed), max ?? parsed)
    setText(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      className="w-20"
    />
  )
}
